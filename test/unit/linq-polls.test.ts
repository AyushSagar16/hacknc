// Native Linq polls against the payload shapes observed on a real line (test/fixtures/linq):
// GET /messages/{id}/poll nests options under `poll` and names their id `option_id`, and the
// poll.vote.added webhook carries only message_id + option_id. A vote must resolve from those,
// and must never be dropped just because a lookup hiccups.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LinqApi, optionIdOf } from "../../src/transport/linq/api.ts";
import { isSkip, readLinqEvent, UNKNOWN_POLL_OPTION, type PollInfo, type ReadContext } from "../../src/transport/linq/events.ts";
import { linqPollSource } from "../../src/transport/linq/platform.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/linq/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const POLL = fixture("poll-get.json");
const VOTE = fixture("poll-vote-added.json") as { event_type: string; event_id: string; data: Record<string, unknown> };
const POLL_ID = "ccc2022b-9ff1-4915-9254-89f0d90a3512";
const GATLINBURG = "d14cc9c0-beff-4dac-a6f6-e24fe8a2e1c2";
const at = new Date("2026-10-10T22:31:00Z");

function apiReturning(body: unknown, status = 200) {
  const calls: string[] = [];
  const api = new LinqApi({
    apiKey: "test",
    baseUrl: "http://linq.test",
    maxRetries: 0,
    fetch: (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return { api, calls };
}

const infoFrom = (poll: Awaited<ReturnType<LinqApi["getPoll"]>>): PollInfo => ({
  title: "where are we going?",
  options: poll.options.map((o) => ({ id: optionIdOf(o), text: o.text, voters: (o.voters ?? []).map((v) => v.handle) })),
});

const ctxWith = (pollInfo: ReadContext["pollInfo"]): ReadContext => ({ selfHandles: new Set(["+19195550000"]), pollInfo, download: async () => Buffer.from("") });
const readVote = (c: ReadContext, data: Record<string, unknown> = VOTE.data) => readLinqEvent({ event_type: VOTE.event_type, event_id: VOTE.event_id, data }, "wh_1", at, c);

describe("Linq native polls (real payload shapes)", () => {
  it("reads GET /messages/{id}/poll: nested poll, option_id, voters", async () => {
    const { api, calls } = apiReturning(POLL);
    const poll = await api.getPoll(POLL_ID);
    expect(calls[0]).toBe(`http://linq.test/messages/${POLL_ID}/poll`);
    expect(poll.message_id).toBe(POLL_ID);
    expect(poll.chat_id).toBe("10df84ec-96bc-40ea-84fe-449c38b44e43");
    expect(poll.options.map(optionIdOf)).toEqual(["38ff39d9-f769-4570-84f0-3a71bff4e0d5", GATLINBURG, "6e456c97-c4e5-47e9-9dea-dfab23339f11"]);
    expect(poll.options[1]!.voters).toHaveLength(4);
    // An older flat shape with `id` still reads.
    const flat = await apiReturning({ message_id: "p", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }).api.getPoll("p");
    expect(flat.options.map(optionIdOf)).toEqual(["a", "b"]);
  });

  it("returns option ids from createPoll when Linq includes them, and none when it doesn't", async () => {
    const withOptions = await apiReturning({ message_id: "p1", poll: { options: [{ option_id: "x", text: "A" }, { option_id: "y", text: "B" }] } }, 202).api.createPoll("c", ["A", "B"]);
    expect(withOptions).toMatchObject({ messageId: "p1", options: [{ option_id: "x" }, { option_id: "y" }] });
    const bare = await apiReturning({ message_id: "p2" }, 202).api.createPoll("c", ["A", "B"]);
    expect(bare).toEqual({ messageId: "p2", options: undefined });
  });

  it("maps the voter list for reconciliation (handles + vote times)", async () => {
    const snap = await linqPollSource(apiReturning(POLL).api)(POLL_ID);
    expect(snap.options.map((o) => [o.text, o.voters.length])).toEqual([["Medellín (~$835)", 0], ["Gatlinburg (~$630)", 4], ["Asheville (~$685)", 0]]);
    expect(snap.options[1]!.voters[0]).toEqual({ handle: "+19195550101", votedAt: new Date("2026-10-10T22:30:53Z") });
  });

  it("turns the real poll.vote.added webhook into a vote for the right option", async () => {
    const info = infoFrom(await apiReturning(POLL).api.getPoll(POLL_ID));
    const r = await readVote(ctxWith(async () => info));
    expect(isSkip(r)).toBe(false);
    expect(r).toMatchObject({
      content: { type: "poll_option", option: { title: "Gatlinburg (~$630)" }, selected: true },
      sender: { id: "+19195550101" },
      space: { id: "10df84ec-96bc-40ea-84fe-449c38b44e43" },
      pollMessageId: POLL_ID,
      optionId: GATLINBURG,
      isGroup: true,
    });
  });

  it("re-reads the poll when the cached options have no ids yet (the poll was just created)", async () => {
    const info = infoFrom(await apiReturning(POLL).api.getPoll(POLL_ID));
    const asks: (boolean | undefined)[] = [];
    const stale: PollInfo = { title: "where are we going?", options: info.options.map((o) => ({ id: "", text: o.text })) };
    const r = await readVote(ctxWith(async (_id, opts) => (asks.push(opts?.fresh), opts?.fresh ? info : stale)));
    expect(asks).toEqual([undefined, true]);
    expect(r).toMatchObject({ content: { option: { title: "Gatlinburg (~$630)" } } });
  });

  it("falls back to the poll's voter list when the option id doesn't match", async () => {
    const info = infoFrom(await apiReturning(POLL).api.getPoll(POLL_ID));
    const r = await readVote(ctxWith(async () => info), { ...VOTE.data, option_id: "some-other-id" });
    expect(r).toMatchObject({ content: { option: { title: "Gatlinburg (~$630)" } } });
  });

  it("never drops a vote it can't read: it goes through as unreadable so the poll gets reconciled", async () => {
    const r = await readVote(ctxWith(async () => {
      throw new Error("linq is down");
    }));
    expect(isSkip(r)).toBe(false);
    expect(r).toMatchObject({ content: { type: "poll_option", option: { title: UNKNOWN_POLL_OPTION } }, pollMessageId: POLL_ID, sender: { id: "+19195550101" } });
  });

  it("still skips Atlas's own vote", async () => {
    const own = { ...VOTE.data, direction: "outbound" };
    expect(isSkip(await readVote(ctxWith(async () => undefined), own))).toBe(true);
  });
});
