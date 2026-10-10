// A stand-in for the Linq Partner API v3 on a local port, recording every call. Typing returns 403
// in group chats, as observed on real lines. Polls answer in the real GET /messages/{id}/poll shape
// ({chat_id, message_id, poll: {options: [{option_id, text, voters}], total_voters}}); tests record
// voters with vote() and can make the next poll reads fail with failPollReads().
import { createServer, type Server } from "node:http";

export interface LinqCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export async function fakeLinq(opts: { line?: string; members?: string[] } = {}) {
  const calls: LinqCall[] = [];
  const polls = new Map<string, { chatId: string; options: { id: string; text: string; voters: { handle: string; voted_at: string }[] }[] }>();
  let n = 0;
  let pollReadFailures = 0;
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
        const options = ((body?.poll as { options: { text: string }[] }).options ?? []).map((o, i) => ({ id: `${id}_o${i}`, text: o.text, voters: [] }));
        polls.set(id, { chatId: m[1]!, options });
        return reply(202, { message_id: id });
      }
      if (req.method === "GET" && (m = /^\/messages\/([^/]+)\/poll$/.exec(path))) {
        if (pollReadFailures > 0) {
          pollReadFailures -= 1;
          return reply(500, { error: { message: "temporarily unavailable" } });
        }
        const p = polls.get(m[1]!);
        if (!p) return reply(404, {});
        const options = p.options.map((o) => ({ can_be_edited: false, option_id: o.id, text: o.text, voters: o.voters }));
        const total = new Set(p.options.flatMap((o) => o.voters.map((v) => v.handle))).size;
        return reply(200, { chat_id: p.chatId, message_id: m[1], poll: { options, total_voters: total }, reactions: [] });
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
    /** Record (or take back) a native vote the way the real poll would show it. */
    vote(pollId: string, optionIdx: number, handle: string, on = true) {
      const option = polls.get(pollId)?.options[optionIdx];
      if (!option) throw new Error(`no option ${optionIdx} on ${pollId}`);
      option.voters = option.voters.filter((v) => v.handle !== handle);
      if (on) option.voters.push({ handle, voted_at: new Date().toISOString() });
      return option.id;
    },
    /** The next `count` poll reads return 500 (each retry counts). */
    failPollReads(count: number) {
      pollReadFailures = count;
    },
    sends: () => calls.filter((c) => c.method === "POST" && /\/messages$|\/polls$|\/reactions$/.test(c.path)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
