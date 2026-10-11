// Receives Linq webhooks on localhost. Every delivery is signature-checked (Standard
// Webhooks: HMAC-SHA256 over "id.timestamp.body"), schema-checked, and written to the
// durable event log BEFORE we answer 200 — a crash after the ack can no longer lose a
// message, and Linq's at-least-once redeliveries are dropped by the log's primary key.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { z } from "zod";
import { childLog } from "../../log.ts";

export const WEBHOOK_PATH = "/linq-events";

export const envelopeSchema = z.object({
  event_type: z.string(),
  event_id: z.string().optional(),
  created_at: z.string().optional(),
  data: z.unknown(),
});
export type LinqEnvelope = z.infer<typeof envelopeSchema>;

export interface WebhookEvent {
  id: string;
  envelope: LinqEnvelope;
  receivedAt: Date;
}

export interface WebhookSink {
  /** Persist the raw event; resolves false when it was already seen (a redelivery). */
  persist(event: WebhookEvent): Promise<boolean>;
  /** Hand a newly persisted event to the platform's ordered queue. Must not throw. */
  enqueue(event: WebhookEvent): void;
}

export interface VerifyInput {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now: Date;
  toleranceSeconds?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Standard Webhooks verification (https://www.standardwebhooks.com). */
export function verifySignature(input: VerifyInput): VerifyResult {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing webhook-id/timestamp/signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(input.now.getTime() / 1000 - ts) > tolerance) return { ok: false, reason: "timestamp outside tolerance" };
  const key = input.secret.startsWith("whsec_")
    ? Buffer.from(input.secret.slice("whsec_".length), "base64")
    : Buffer.from(input.secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${input.body}`).digest();
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

export function signForTest(secret: string, id: string, timestamp: string, body: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** Another POST endpoint on the same server (e.g. /connect-callback). Gets the raw body. */
export type RouteHandler = (req: { body: string; header(name: string): string | undefined }) => Promise<{ status: number; json?: unknown }>;

export interface WebhookServerOptions {
  port: number;
  host?: string;
  /** Current signing secret; undefined means "not known yet" (see `allowUnsigned`). */
  secret: () => string | undefined;
  /**
   * Relay mode on localhost only: if the CLI's session secret could not be captured,
   * accept unsigned deliveries rather than dropping the whole conversation. Off in
   * subscription mode, where a public tunnel is in front of us.
   */
  allowUnsigned: boolean;
  sink: WebhookSink;
  now?: () => Date;
  maxBodyBytes?: number;
  routes?: Record<string, RouteHandler>;
}

export function startWebhookServer(options: WebhookServerOptions): Promise<Server> {
  const log = childLog({ component: "linq.webhook" });
  const now = options.now ?? (() => new Date());
  const maxBody = options.maxBodyBytes ?? 1_000_000;
  let warnedUnsigned = false;

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const route = options.routes?.[path];
      if (req.method !== "POST" || (path !== WEBHOOK_PATH && !route)) {
        res.writeHead(404).end();
        return;
      }
      const body = await readBody(req, maxBody);
      const header = (name: string) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      };
      if (route) {
        const out = await route({ body, header });
        res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.json ?? {}));
        return;
      }
      const webhookId = header("webhook-id") ?? header("x-webhook-id");
      const secret = options.secret();
      if (secret) {
        const result = verifySignature({
          secret,
          id: webhookId,
          timestamp: header("webhook-timestamp") ?? header("x-webhook-timestamp"),
          signature: header("webhook-signature") ?? header("x-webhook-signature"),
          body,
          now: now(),
        });
        if (!result.ok) {
          log.warn({ reason: result.reason }, "rejected webhook");
          res.writeHead(401).end();
          return;
        }
      } else if (!options.allowUnsigned) {
        log.error("no webhook secret configured; rejecting delivery");
        res.writeHead(503).end();
        return;
      } else if (!warnedUnsigned) {
        warnedUnsigned = true;
        log.warn("accepting unsigned localhost deliveries (relay secret not captured)");
      }

      let envelope: LinqEnvelope;
      try {
        envelope = envelopeSchema.parse(JSON.parse(body));
      } catch {
        // Malformed bodies are acknowledged so Linq stops retrying them; they're logged for a human.
        log.warn({ bytes: body.length }, "unparseable webhook body");
        res.writeHead(200).end();
        return;
      }
      const id = webhookId ?? envelope.event_id;
      if (!id) {
        res.writeHead(200).end();
        return;
      }
      const event: WebhookEvent = { id, envelope, receivedAt: now() };
      const isNew = await options.sink.persist(event);
      res.writeHead(200).end();
      if (isNew) options.sink.enqueue(event);
    } catch (err) {
      // Persisting failed (DB down): answer 500 so Linq redelivers later.
      log.error({ err: (err as Error).message }, "webhook handling failed");
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("webhook body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
