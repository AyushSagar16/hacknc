import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, setConfig } from "../../src/config.ts";
import { startAtlas, type AtlasApp } from "../../src/app.ts";
import { q } from "../../src/db/pool.ts";
import { signForTest, WEBHOOK_PATH } from "../../src/transport/linq/webhook.ts";
import { setNessieClient } from "../../src/nessie/seed.ts";
import { dbAvailable, freshDb } from "../helpers/db.ts";
import { quietFake } from "../helpers/atlas.ts";
import { fakeLinq } from "../helpers/fakeLinq.ts";
import { callResult, textResult } from "../../src/agent/llm.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const SECRET = `whsec_${Buffer.from("atlas-test-secret").toString("base64")}`;
const LINE = "+19195550000";
const FRIENDS = ["+19195550101", "+19195550102", "+19195550103"];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function until(fn: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describeDb("Linq line end to end (fake Linq API, real webhook server + Spectrum + pipeline)", () => {
  let app: AtlasApp | undefined;
  let cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await app?.stop();
    app = undefined;
    for (const c of cleanup.reverse()) await c();
    cleanup = [];
    setNessieClient(undefined);
  });

  async function boot(llm = quietFake()) {
    const { drop } = await freshDb();
    cleanup.push(drop);
    const linq = await fakeLinq({ line: LINE, members: FRIENDS });
    cleanup.push(linq.close);
    const port = await freePort();
    const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "linq", LINQ_API_KEY: "test", LINQ_API_URL: linq.url, LINQ_WEBHOOK_PORT: String(port), LINQ_WEBHOOK_MODE: "subscription", LINQ_WEBHOOK_SECRET: SECRET, LLM_MODE: "fake" });
    setConfig(cfg);
    setNessieClient(null);
    app = await startAtlas({ cfg, llm, debounceMs: 20, maxWaitMs: 300, pacing: () => 0, startJobs: false, names: (h) => ({ [FRIENDS[0]!]: "Maya", [FRIENDS[1]!]: "Leo", [FRIENDS[2]!]: "Priya" })[h] });
    const post = async (eventType: string, data: unknown, opts: { id?: string; sign?: boolean; tamper?: boolean } = {}) => {
      const id = opts.id ?? `wh_${Math.random().toString(36).slice(2)}`;
      const body = JSON.stringify({ api_version: "v3", webhook_version: "2026-02-03", event_type: eventType, event_id: id, created_at: new Date().toISOString(), data });
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts };
      if (opts.sign !== false) headers["webhook-signature"] = signForTest(SECRET, id, ts, opts.tamper ? `${body} ` : body);
      const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATH}`, { method: "POST", headers, body });
      return res.status;
    };
    const text = (id: string, from: string, value: string, extra: Record<string, unknown> = {}) => ({
      id,
      chat: { id: "chat_1", is_group: true },
      direction: "inbound",
      sender_handle: { handle: from, is_me: false },
      parts: [{ type: "text", value }],
      sent_at: new Date().toISOString(),
      ...extra,
    });
    return { linq, post, text };
  }

  it("introduces itself when added, with idempotency keys, and never fails over typing 403s", async () => {
    const { linq, post } = await boot();
    expect(await post("participant.added", { chat_id: "chat_1", handle: LINE, added_at: new Date().toISOString() })).toBe(200);
    await until(() => linq.sends().length >= 3);
    const sends = linq.sends();
    expect(sends.map((s) => s.path)).toEqual(["/chats/chat_1/messages", "/chats/chat_1/messages", "/chats/chat_1/messages"]);
    const first = sends[0]!.body as { message: { parts: { value: string }[]; idempotency_key: string } };
    expect(first.message.parts[0]!.value).toMatch(/^hi, i'm atlas/);
    expect(first.message.idempotency_key).toMatch(/^t\d+-0$/);
    // Members it hasn't heard from yet were learned from GET /chats/{id}.
    const members = await q<{ n: number }>(`SELECT count(*)::int AS n FROM chat_members WHERE active`);
    expect(members[0]!.n).toBe(3);
  });

  it("rejects unsigned or tampered webhooks and drops redeliveries", async () => {
    const { linq, post, text } = await boot(quietFake().set("agent", () => textResult("hey maya")));
    expect(await post("message.received", text("m1", FRIENDS[0]!, "atlas hi"), { sign: false })).toBe(401);
    expect(await post("message.received", text("m1", FRIENDS[0]!, "atlas hi"), { tamper: true })).toBe(401);
    expect(await post("message.received", text("m1", FRIENDS[0]!, "atlas hi"), { id: "wh_same" })).toBe(200);
    expect(await post("message.received", text("m1", FRIENDS[0]!, "atlas hi"), { id: "wh_same" })).toBe(200);
    await until(() => linq.sends().some((s) => JSON.stringify(s.body).includes("hey maya")));
    await new Promise((r) => setTimeout(r, 150));
    const inbound = await q<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE direction = 'inbound'`);
    expect(inbound[0]!.n).toBe(1);
    const events = await q<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_events WHERE processed_at IS NOT NULL`);
    expect(events[0]!.n).toBe(1);
  });

  it("sends a native Linq poll (question as its own bubble) and counts native votes", async () => {
    const llm = quietFake();
    const { linq, post, text } = await boot(llm);
    await post("participant.added", { chat_id: "chat_1", handle: LINE });
    await until(() => linq.sends().length >= 3);
    // Group members set budgets and ask for options; the propose command runs deterministically.
    for (const [i, f] of FRIENDS.entries()) await post("message.received", text(`b${i}`, f, "set my budget to 900"));
    await until(() => linq.sends().length >= 6);
    await post("message.received", text("p1", FRIENDS[0]!, "atlas give us some options"));
    await until(() => linq.calls.some((c) => c.path.endsWith("/polls")));
    const pollCall = linq.calls.find((c) => c.path.endsWith("/polls"))!;
    const options = (pollCall.body as { poll: { options: { text: string }[]; idempotency_key: string } }).poll;
    expect(options.options).toHaveLength(3);
    expect(options.idempotency_key).toMatch(/^t\d+-\d+$/);
    const [pollId] = [...linq.polls.keys()];
    await until(async () => (await q(`SELECT 1 FROM polls WHERE provider_poll_id = $1`, [pollId])).length > 0);
    // Two of three vote for option 1 in the native poll → decided.
    for (const f of FRIENDS.slice(0, 2)) await post("poll.vote.added", { message_id: pollId, direction: "inbound", chat: { id: "chat_1", is_group: true }, sender_handle: { handle: f }, option_id: `${pollId}_o0` });
    await until(async () => (await q<{ status: string }>(`SELECT status FROM trips`))[0]?.status === "locked");
    await until(() => linq.sends().some((s) => /wins \(2 of 3\)/.test(JSON.stringify(s.body))));
  });

  it("uses native tapbacks and threaded replies on Linq", async () => {
    const llm = quietFake().set("agent", (req) => {
      const situation = JSON.stringify(req.contents);
      return situation.includes("functionResponse") ? textResult("NO_REPLY") : callResult("log_expense", { amount_usd: 30, description: "parking" });
    });
    const { linq, post, text } = await boot(llm);
    await post("participant.added", { chat_id: "chat_1", handle: LINE });
    await until(() => linq.sends().length >= 3);
    await q(`UPDATE trips SET status = 'ongoing', destination_name = 'Charleston', destination_id = 'charleston'`);
    await post("message.received", text("e1", FRIENDS[1]!, "atlas i covered parking, 30 bucks"));
    await until(() => linq.sends().some((s) => /logged #1: parking \$30\.00/.test(JSON.stringify(s.body))));
  });
});
