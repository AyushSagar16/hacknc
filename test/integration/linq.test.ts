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
import { reconcileOpenNativePolls, setPollSource } from "../../src/agent/features/proposals.ts";
import { linqPollSource } from "../../src/transport/linq/platform.ts";
import { signBody, verifyToken } from "../../src/connect/token.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const SECRET = `whsec_${Buffer.from("atlas-test-secret").toString("base64")}`;
const LINE = "+19195550000";
const FRIENDS = ["+19195550101", "+19195550102", "+19195550103"];
const FOUR = [...FRIENDS, "+19195550104"];
const NAMES: Record<string, string> = { [FOUR[0]!]: "Maya", [FOUR[1]!]: "Leo", [FOUR[2]!]: "Priya", [FOUR[3]!]: "Sai" };

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
    setPollSource(undefined);
  });

  async function boot(llm = quietFake(), friends = FRIENDS) {
    const { url, drop } = await freshDb();
    cleanup.push(drop);
    const linq = await fakeLinq({ line: LINE, members: friends });
    cleanup.push(linq.close);
    const port = await freePort();
    const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "linq", LINQ_API_KEY: "test", LINQ_API_URL: linq.url, LINQ_WEBHOOK_PORT: String(port), LINQ_WEBHOOK_MODE: "subscription", LINQ_WEBHOOK_SECRET: SECRET, LLM_MODE: "fake", DATABASE_URL: url });
    setConfig(cfg);
    setNessieClient(null);
    app = await startAtlas({ cfg, llm, debounceMs: 20, maxWaitMs: 300, pacing: () => 0, startJobs: false, names: (h) => NAMES[h] });
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

  /** Atlas joins a group of `friends`, everyone sets a budget, and Atlas posts a native poll. */
  async function bootWithPoll(friends: string[], llm = quietFake()) {
    const booted = await boot(llm, friends);
    const { linq, post, text } = booted;
    await post("participant.added", { chat_id: "chat_1", handle: LINE });
    await until(() => linq.sends().length >= 3);
    for (const [i, f] of friends.entries()) await post("message.received", text(`b${i}`, f, "set my budget to 900"));
    await until(() => linq.sends().length >= 3 + friends.length);
    await post("message.received", text("p1", friends[0]!, "atlas give us some options"));
    await until(() => linq.calls.some((c) => c.path.endsWith("/polls")));
    const [pollId] = [...linq.polls.keys()];
    await until(async () => (await q(`SELECT 1 FROM polls WHERE provider_poll_id = $1`, [pollId])).length > 0);
    // A vote webhook exactly as Linq sends it (see test/fixtures/linq/poll-vote-added.json).
    const vote = (from: string, optionIdx: number) => {
      const optionId = linq.vote(pollId!, optionIdx, from);
      return post("poll.vote.added", {
        chat: { id: "chat_1", is_group: true, owner_handle: { handle: LINE, is_me: true } },
        service: "iMessage",
        direction: "inbound",
        option_id: optionId,
        message_id: pollId,
        sender_handle: { handle: from, is_me: false, status: "active", service: "iMessage" },
        zero_retention: false,
      });
    };
    const tripStatus = async () => (await q<{ status: string }>(`SELECT status FROM trips`))[0]?.status;
    const sentText = () => linq.sends().map((s) => JSON.stringify(s.body)).join("\n");
    return { ...booted, pollId: pollId!, vote, tripStatus, sentText };
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

  it("bank connect: \"yes\" gets a signed link, and the consent page's signed POST /connect-callback connects them", async () => {
    const { linq, post, text } = await boot();
    const port = app!.cfg.LINQ_WEBHOOK_PORT;
    const secret = "connect-test-secret";
    app!.cfg.CONNECT_SECRET = secret;
    await post("participant.added", { chat_id: "chat_1", handle: LINE });
    await until(() => linq.sends().length >= 3);
    await post("message.received", text("y1", FRIENDS[0]!, "yes"));
    const sent = () => linq.sends().map((s) => JSON.stringify(s.body)).join("\n");
    await until(() => sent().includes("/connect/"));
    expect(sent()).toContain("here's yours maya 🔒");
    const token = /\/connect\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(sent())![1]!;
    expect(verifyToken(token, secret, Date.now())).toMatchObject({ ok: true, payload: { n: "Maya", cb: `http://127.0.0.1:${port}` } });

    const callback = (body: string, signature: string) =>
      fetch(`http://127.0.0.1:${port}/connect-callback`, { method: "POST", headers: { "content-type": "application/json", "x-atlas-signature": signature }, body });
    const body = JSON.stringify({ token });
    expect((await callback(body, signBody(body, "wrong"))).status).toBe(401);
    const forged = JSON.stringify({ token: `${token.split(".")[0]}.${signBody("x", secret)}` });
    expect((await callback(forged, signBody(forged, secret))).status).toBe(400);
    const ok = await callback(body, signBody(body, secret));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, name: "Maya", already: false });
    expect(await (await callback(body, signBody(body, secret))).json()).toMatchObject({ ok: true, already: true });

    await app!.jobs.runDue();
    await until(() => sent().includes("maya's connected ✓"));
    const rows = await q<{ status: string; seed_status: string }>(`SELECT b.status, l.seed_status FROM bank_connections b JOIN nessie_links l USING (person_id) WHERE b.status = 'connected'`);
    expect(rows).toEqual([{ status: "connected", seed_status: "ready" }]);
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
    await until(() => linq.sends().some((s) => /it is! 2 of 3 votes/.test(JSON.stringify(s.body))));
  });

  it("4 native votes in a 4-person group lock the trip and post the lock-in and links unprompted, with no plan yet", async () => {
    const { vote, tripStatus, sentText, linq } = await bootWithPoll(FOUR);
    const pollSends = linq.sends().length;
    await q(`UPDATE trips SET start_date = '2026-11-12', end_date = '2026-11-15'`);
    // The poll cache has no option ids yet (Linq's create response carries none), so the first
    // vote is resolved through GET /messages/{id}/poll — the shape that used to be misread.
    await vote(FOUR[0]!, 1);
    await until(async () => (await q(`SELECT 1 FROM votes`)).length === 1);
    // A partial tally stays quiet: the votes show on the poll itself.
    await new Promise((r) => setTimeout(r, 150));
    expect(linq.sends().length).toBe(pollSends);
    for (const f of FOUR.slice(1)) await vote(f, 1);
    await until(async () => (await tripStatus()) === "locked");
    // A strict majority (3 of 4) already decides; if the 4th lands in the same batch it's unanimous.
    await until(() => /it is! (unanimous, 4 for 4|3 of 4 votes)/.test(sentText()));
    await until(() => /locked in for nov 12–15/.test(sentText()) && /ready to book\?/.test(sentText()));
    // The day-by-day plan waits for the stay and the food & activities picks.
    await new Promise((r) => setTimeout(r, 150));
    expect(await q(`SELECT 1 FROM jobs WHERE kind = 'site.itinerary_nudge'`)).toEqual([]);
    const skipped = await q<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_events WHERE event_type = 'poll.vote.added' AND error IS NOT NULL`);
    expect(skipped[0]!.n).toBe(0);
  });

  it("reconciles from the poll's voter list: lost vote webhooks still count, and the lock-in posts itself", async () => {
    const { linq, vote, tripStatus, sentText, pollId } = await bootWithPoll(FOUR);
    setPollSource(linqPollSource(app!.transport.linq!.api));
    // Three people vote on their phones but Atlas never gets those webhooks…
    for (const f of FOUR.slice(0, 3)) linq.vote(pollId, 2, f);
    expect(await tripStatus()).toBe("voting");
    // …then one webhook arrives, and the provider's list fills in the rest.
    await vote(FOUR[3]!, 2);
    await until(async () => (await tripStatus()) === "locked");
    await until(() => /it is! unanimous, 4 for 4/.test(sentText()));
    const votes = await q<{ n: number }>(`SELECT count(*)::int AS n FROM votes WHERE selected`);
    expect(votes[0]!.n).toBe(4);
  });

  it("'we all voted' makes Atlas read the poll and lock it in", async () => {
    const { linq, post, text, tripStatus, sentText, pollId } = await bootWithPoll(FOUR);
    setPollSource(linqPollSource(app!.transport.linq!.api));
    for (const f of FOUR) linq.vote(pollId, 0, f);
    await post("message.received", text("v1", FOUR[1]!, "ok we all voted"));
    await until(async () => (await tripStatus()) === "locked");
    await until(() => /it is! unanimous/.test(sentText()));
  });

  it("a text vote and a native vote from the same person count once", async () => {
    const { post, text, vote, tripStatus } = await bootWithPoll(FOUR);
    setPollSource(linqPollSource(app!.transport.linq!.api));
    const titles = await q<{ options: { title: string }[] }>(`SELECT options FROM polls WHERE status = 'open'`);
    const place = titles[0]!.options[1]!.title.split(" (")[0]!;
    await post("message.received", text("t1", FOUR[0]!, place));
    await until(async () => (await q(`SELECT 1 FROM votes`)).length === 1);
    await vote(FOUR[0]!, 1);
    await vote(FOUR[1]!, 1);
    // 2 distinct voters of 4 for option 2: not a strict majority, so still voting.
    await until(async () => (await q<{ n: number }>(`SELECT count(DISTINCT person_id)::int AS n FROM votes WHERE selected`))[0]!.n === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(await tripStatus()).toBe("voting");
    await vote(FOUR[2]!, 1);
    await until(async () => (await tripStatus()) === "locked");
  });

  it("on startup, open native polls are reconciled and a decided one locks without anyone asking", async () => {
    const { linq, tripStatus, sentText, pollId } = await bootWithPoll(FOUR);
    setPollSource(linqPollSource(app!.transport.linq!.api));
    for (const f of FOUR.slice(0, 3)) linq.vote(pollId, 1, f); // votes while Atlas was "down"
    expect(await reconcileOpenNativePolls(app!.services)).toBe(1);
    await until(async () => (await tripStatus()) === "locked");
    await until(() => /it is! 3 of 4 votes/.test(sentText()));
    // Nothing left to do on a second pass.
    expect(await reconcileOpenNativePolls(app!.services)).toBe(0);
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
