// Picks the iMessage line by IMESSAGE_MODE and wires it into one Spectrum app:
//   linq  — a Linq line (custom platform, webhooks via the CLI relay or a subscription)
//   local — this Mac's Messages account (@spectrum-ts/imessage-local)
//   cloud — Photon Spectrum Cloud (needs a dedicated Business line for groups)
//   sim   — the in-process simulator (no phones)
import type { Server } from "node:http";
import { Spectrum, type Message, type Space, type SpectrumInstance } from "spectrum-ts";
import { setLogLevel } from "spectrum-ts/authoring";
import type { Config } from "../config.ts";
import { childLog } from "../log.ts";
import type { ChatRow } from "../db/repos/core.ts";
import { markWebhookProcessed, unprocessedWebhookEvents, webhookSink } from "../pipeline/webhookStore.ts";
import { LinqApi } from "./linq/api.ts";
import { linqPlatform } from "./linq/platform.ts";
import { startWebhookServer, type WebhookEvent } from "./linq/webhook.ts";
import { EventQueue } from "./queue.ts";
import { SimWorld, simPlatform } from "./sim/platform.ts";

export interface Transport {
  mode: Config["IMESSAGE_MODE"];
  platform: string;
  app: SpectrumInstance;
  resolveSpace(chat: ChatRow): Promise<Space>;
  /** Run the inbound loop until stop(); rebuilds the Spectrum app if its stream ever ends. */
  run(onMessage: (space: Space, message: Message) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  world?: SimWorld;
  linq?: { api: LinqApi; setSecret(secret: string | undefined): void; selfHandles: Set<string> };
}

export async function createTransport(cfg: Config, opts: { world?: SimWorld; onRival?: (chatId: string) => void } = {}): Promise<Transport> {
  setLogLevel("warn");
  const log = childLog({ component: "transport", mode: cfg.IMESSAGE_MODE });
  let stopping = false;
  const cleanups: (() => Promise<void> | void)[] = [];

  let build: () => Promise<SpectrumInstance>;
  let resolve: (app: SpectrumInstance, chat: ChatRow) => Promise<Space>;
  let platform: string;
  let world: SimWorld | undefined;
  let linq: Transport["linq"];

  switch (cfg.IMESSAGE_MODE) {
    case "sim": {
      world = opts.world ?? new SimWorld();
      const sim = simPlatform(world);
      platform = "sim";
      build = () => Spectrum({ providers: [sim.config({})] });
      resolve = (app, chat) => sim(app).space.get(chat.provider_chat_id);
      cleanups.push(() => world!.queue.close());
      break;
    }
    case "linq": {
      if (!cfg.LINQ_API_KEY) throw new Error("IMESSAGE_MODE=linq needs LINQ_API_KEY (run `linq signup`, then put the key in .env)");
      const api = new LinqApi({ apiKey: cfg.LINQ_API_KEY, baseUrl: cfg.LINQ_API_URL });
      const selfHandles = new Set<string>();
      try {
        for (const phone of await api.listPhoneNumbers()) selfHandles.add(phone);
      } catch (err) {
        log.warn({ err: (err as Error).message }, "could not list the line's phone numbers");
      }
      const queue = new EventQueue<WebhookEvent>();
      let secret = cfg.LINQ_WEBHOOK_SECRET;
      const server: Server = await startWebhookServer({
        port: cfg.LINQ_WEBHOOK_PORT,
        secret: () => secret,
        allowUnsigned: cfg.LINQ_WEBHOOK_MODE === "relay",
        sink: webhookSink((event) => queue.push(event)),
      });
      // Replay anything persisted but never handled before the last shutdown.
      for (const event of await unprocessedWebhookEvents()) queue.push(event);
      const lp = linqPlatform({
        api,
        queue,
        selfHandles: () => selfHandles,
        onSkip: (event, reason) => void markWebhookProcessed(event.id, reason).catch(() => {}),
        onRival: (chatId, messageId) => {
          log.error({ chatId, messageId }, "this line sent a message this process didn't — is another Atlas running on the same Linq line?");
          opts.onRival?.(chatId);
        },
      });
      platform = "linq";
      build = () => Spectrum({ providers: [lp.config({})] });
      resolve = (app, chat) => lp(app).space.get(chat.provider_chat_id);
      linq = { api, selfHandles, setSecret: (s) => (secret = s) };
      cleanups.push(() => queue.close(), () => new Promise<void>((r) => server.close(() => r())));
      log.info({ port: cfg.LINQ_WEBHOOK_PORT, handles: [...selfHandles].length }, "linq webhook server listening");
      break;
    }
    case "local": {
      const { localIMessage } = await import("@spectrum-ts/imessage-local");
      platform = "local_imessage";
      build = () => Spectrum({ providers: [localIMessage.config()] });
      resolve = (app, chat) => localIMessage(app).space.get(chat.provider_chat_id);
      break;
    }
    case "cloud": {
      const { imessage } = await import("spectrum-ts/providers/imessage");
      if (!cfg.PROJECT_ID || !cfg.PROJECT_SECRET) throw new Error("IMESSAGE_MODE=cloud needs PROJECT_ID and PROJECT_SECRET");
      platform = "imessage";
      build = () => Spectrum({ projectId: cfg.PROJECT_ID!, projectSecret: cfg.PROJECT_SECRET!, providers: [imessage.config()] });
      resolve = (app, chat) => imessage(app).space.get(chat.provider_chat_id);
      break;
    }
  }

  let app = await build();

  return {
    mode: cfg.IMESSAGE_MODE,
    platform,
    get app() {
      return app;
    },
    world,
    linq,
    resolveSpace: (chat) => resolve(app, chat),
    async run(onMessage) {
      let backoff = 1_000;
      while (!stopping) {
        try {
          for await (const [space, message] of app.messages) {
            backoff = 1_000;
            try {
              await onMessage(space, message);
            } catch (err) {
              log.error({ err: (err as Error).message }, "inbound handler threw");
            }
          }
        } catch (err) {
          log.error({ err: (err as Error).message }, "inbound stream failed");
        }
        if (stopping) break;
        // app.messages ended without stop(): a provider stream died. Rebuild rather than go deaf.
        log.error({ backoffMs: backoff }, "inbound stream ended unexpectedly; rebuilding the Spectrum app");
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
        await app.stop().catch(() => {});
        app = await build();
      }
    },
    async stop() {
      stopping = true;
      for (const fn of cleanups) await fn();
      await app.stop().catch(() => {});
    },
  };
}
