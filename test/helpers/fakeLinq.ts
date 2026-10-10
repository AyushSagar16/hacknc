// A stand-in for the Linq Partner API v3 on a local port, recording every call. Typing returns 403
// in group chats, as observed on real lines.
import { createServer, type Server } from "node:http";

export interface LinqCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export async function fakeLinq(opts: { line?: string; members?: string[] } = {}) {
  const calls: LinqCall[] = [];
  const polls = new Map<string, { options: { id: string; text: string }[] }>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "/").replace(/^\/api\/partner\/v3/, "");
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : null;
      calls.push({ method: req.method ?? "GET", path, body });
      const reply = (status: number, value?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      let m: RegExpExecArray | null;
      if (req.method === "GET" && path === "/phone_numbers") return reply(200, { phone_numbers: [{ phone_number: opts.line ?? "+19195550000" }] });
      if (req.method === "GET" && path.startsWith("/webhook-subscriptions")) return reply(200, { webhook_subscriptions: [] });
      if ((m = /^\/chats\/([^/]+)\/typing$/.exec(path))) return reply(403, { error: { message: "typing indicators are not supported in group chats" } });
      if (req.method === "POST" && (m = /^\/chats\/([^/]+)\/messages$/.exec(path))) return reply(200, { chat_id: m[1], message: { id: `out_${++n}` } });
      if (req.method === "POST" && (m = /^\/chats\/([^/]+)\/polls$/.exec(path))) {
        const id = `poll_${++n}`;
        const options = ((body?.poll as { options: { text: string }[] }).options ?? []).map((o, i) => ({ id: `${id}_o${i}`, text: o.text }));
        polls.set(id, { options });
        return reply(202, { message_id: id });
      }
      if (req.method === "GET" && (m = /^\/messages\/([^/]+)\/poll$/.exec(path))) {
        const p = polls.get(m[1]!);
        return p ? reply(200, { message_id: m[1], options: p.options, total_voters: 0 }) : reply(404, {});
      }
      if (req.method === "POST" && /^\/messages\/[^/]+\/reactions$/.test(path)) return reply(200, {});
      if (req.method === "GET" && (m = /^\/chats\/([^/]+)$/.exec(path))) {
        return reply(200, { id: m[1], is_group: true, handles: [{ handle: opts.line ?? "+19195550000", is_me: true }, ...(opts.members ?? []).map((h) => ({ handle: h, status: "active" }))] });
      }
      reply(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/api/partner/v3`,
    calls,
    polls,
    sends: () => calls.filter((c) => c.method === "POST" && /\/messages$|\/polls$|\/reactions$/.test(c.path)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
