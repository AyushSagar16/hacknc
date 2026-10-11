import { describe, expect, it } from "vitest";
import { isSkip, readLinqEvent, type ReadContext } from "../../src/transport/linq/events.ts";

const LINE = "+19195550000";
const ctx = (polls: Record<string, { title: string; options: { id: string; text: string }[] }> = {}): ReadContext => ({
  selfHandles: new Set([LINE]),
  pollInfo: async (id) => polls[id],
  download: async () => Buffer.from(""),
});
const at = new Date("2026-10-10T18:00:00Z");
const read = (event_type: string, data: unknown, c = ctx()) => readLinqEvent({ event_type, event_id: "evt_1", data }, "wh_1", at, c);

describe("Linq webhook → Spectrum records", () => {
  it("maps a group text (2026-02-03 payload) with is_group and event id extras", async () => {
    const r = await read("message.received", {
      id: "msg_1",
      chat: { id: "chat_1", is_group: true },
      direction: "inbound",
      sender_handle: { handle: "+19195550101", is_me: false },
      parts: [{ type: "text", value: "where should we go?" }],
      sent_at: "2026-10-10T17:59:58Z",
    });
    expect(isSkip(r)).toBe(false);
    expect(r).toMatchObject({ id: "msg_1", content: { type: "text", text: "where should we go?" }, sender: { id: "+19195550101" }, space: { id: "chat_1" }, isGroup: true, eventId: "wh_1" });
  });

  it("maps a threaded reply", async () => {
    const r = await read("message.received", {
      id: "msg_2",
      chat: { id: "chat_1", is_group: true },
      sender_handle: { handle: "+19195550101" },
      parts: [{ type: "text", value: "yes that one" }],
      reply_to: { message_id: "atlas_msg_9" },
    });
    expect(r).toMatchObject({ replyTo: { messageId: "atlas_msg_9" } });
  });

  it("understands the legacy 2025-01-01 payload", async () => {
    const r = await read("message.received", { chat_id: "chat_1", from: "+19195550102", is_from_me: false, is_group: true, message: { id: "m_old", parts: [{ type: "text", value: "hi" }] } });
    expect(r).toMatchObject({ id: "m_old", sender: { id: "+19195550102" }, content: { type: "text", text: "hi" } });
  });

  it("skips Atlas's own messages by direction, is_me or our own number", async () => {
    expect(isSkip(await read("message.received", { id: "a", chat: { id: "c" }, direction: "outbound", sender_handle: { handle: "+1" }, parts: [{ type: "text", value: "x" }] }))).toBe(true);
    expect(isSkip(await read("message.received", { id: "b", chat: { id: "c" }, sender_handle: { handle: "+1", is_me: true }, parts: [{ type: "text", value: "x" }] }))).toBe(true);
    expect(isSkip(await read("message.received", { id: "c", chat: { id: "c" }, sender_handle: LINE, parts: [{ type: "text", value: "x" }] }))).toBe(true);
  });

  it("maps tapbacks, and keeps removals so votes can be taken back", async () => {
    const added = await read("reaction.added", { chat_id: "chat_1", message_id: "opt_2", reaction_type: "like", from: "+19195550101", reacted_at: "2026-10-10T18:00:00Z" });
    expect(added).toMatchObject({ content: { type: "reaction", emoji: "👍", target: { id: "opt_2" } }, sender: { id: "+19195550101" } });
    const removed = await read("reaction.removed", { chat_id: "chat_1", message_id: "opt_2", reaction_type: "like", from: "+19195550101" });
    expect(removed).toMatchObject({ reactionRemoved: true });
    expect(isSkip(await read("reaction.added", { chat_id: "c", message_id: "m", reaction_type: "sticker", from: "+1" }))).toBe(true);
  });

  it("maps native poll votes through the poll's options", async () => {
    const c = ctx({ poll_1: { title: "where to?", options: [{ id: "o1", text: "Savannah (~$555)" }, { id: "o2", text: "Asheville (~$585)" }] } });
    const r = await read("poll.vote.added", { message_id: "poll_1", chat: { id: "chat_1", is_group: true }, sender_handle: { handle: "+19195550101" }, option_id: "o2" }, c);
    expect(r).toMatchObject({ content: { type: "poll_option", option: { title: "Asheville (~$585)" }, selected: true, poll: { title: "where to?" } }, pollMessageId: "poll_1", optionId: "o2" });
    const off = await read("poll.vote.removed", { message_id: "poll_1", chat: { id: "chat_1" }, sender_handle: { handle: "+19195550101" }, option_id: "o2" }, c);
    expect(off).toMatchObject({ content: { selected: false } });
    // A poll it can't read isn't dropped: the vote goes through as unreadable and gets reconciled later.
    const unknown = await read("poll.vote.added", { message_id: "unknown", chat: { id: "c" }, sender_handle: { handle: "+1" }, option_id: "x" }, c);
    expect(unknown).toMatchObject({ content: { type: "poll_option", option: { title: "(unreadable option)" } }, pollMessageId: "unknown" });
  });

  it("maps Atlas being added (participant.added with our number, or chat.created) to a joined event", async () => {
    const joined = await read("participant.added", { chat_id: "chat_1", handle: LINE, added_at: "2026-10-10T18:00:00Z" });
    expect(joined).toMatchObject({ content: { type: "addMember", members: [] }, memberEvent: "joined" });
    const friend = await read("participant.added", { chat_id: "chat_1", handle: "+19195550199" });
    expect(friend).toMatchObject({ content: { type: "addMember", members: ["+19195550199"] }, memberEvent: "added" });
    const created = await read("chat.created", { id: "chat_2", is_group: true, handles: [{ handle: LINE, is_me: true }, { handle: "+19195550101" }, "+19195550102"] });
    expect(created).toMatchObject({ content: { type: "addMember", members: ["+19195550101", "+19195550102"] }, memberEvent: "joined" });
  });

  it("skips everything else without throwing on odd payloads", async () => {
    expect(isSkip(await read("message.delivered", { id: "x" }))).toBe(true);
    expect(isSkip(await read("message.received", { nonsense: true }))).toBe(true);
    expect(isSkip(await read("reaction.added", null))).toBe(true);
  });
});
