// Cases adapted from ethanyanghq/scout tests/test_speak_gate.py (used with permission), plus ours.
import { describe, expect, it } from "vitest";
import { addressedReason, mentionsAgent } from "../../src/agent/addressed.ts";
import type { MessageRow } from "../../src/db/repos/core.ts";

const base = new Date("2026-10-10T18:00:00Z").getTime();
let id = 0;
const msg = (over: Partial<MessageRow>, minutes = 0): MessageRow =>
  ({ id: ++id, chat_id: 1, person_id: 1, provider_message_id: `p${id}`, direction: "inbound", kind: "text", text: "", reply_to_provider_id: null, meta: {}, sent_at: new Date(base + minutes * 60_000), received_at: new Date(base), turn_id: null, speakable: true, extracted_at: null, ...over }) as MessageRow;
const names = new Map([[1, "maya"], [2, "leo"], [3, "priya"]]);
const reason = (message: MessageRow, history: MessageRow[]) => addressedReason({ message, history: [...history, message], agentName: "Atlas", namesById: names });

describe("mentions", () => {
  it.each(["@atlas hi", "hey atlas", "Hey Atlas, what's the plan", "atlas, help", "atlas can you find flights", "ok atlas", "thoughts, atlas?", "what do you think atlas?", "atlas", "UNC winter break, I'm free. Atlas. Let's keep moving.", "ok. atlas, what now", "Atlas: options pls"])("%s → addressed", (t) => {
    expect(mentionsAgent(t, "Atlas")).toBe(true);
  });
  it.each(["atlas seems useful", "let's ask atlas later lol", "lol atlas is so organized", "i love my atlas of the world", "lol. atlas is so organized", "we bought the atlas. it was huge"])("%s → not addressed", (t) => {
    expect(mentionsAgent(t, "Atlas")).toBe(false);
  });
});

describe("addressedReason", () => {
  it("a threaded reply to an Atlas message is addressed; to a friend is not", () => {
    const atlas = msg({ direction: "outbound", person_id: null, text: "want options?", provider_message_id: "atlas1" });
    const friend = msg({ person_id: 2, text: "should we do tulum", provider_message_id: "f1" });
    expect(reason(msg({ reply_to_provider_id: "atlas1", text: "yes" }), [atlas])).toBe("reply_to_atlas");
    expect(reason(msg({ reply_to_provider_id: "f1", text: "maybe" }), [friend])).toBeNull();
  });

  it("a reply to one of a text poll's option bubbles (meta.providerIds) is addressed", () => {
    const poll = msg({ direction: "outbound", person_id: null, kind: "poll", text: "where to?", provider_message_id: "q1", meta: { providerIds: ["q1", "o1", "o2"] } });
    expect(reason(msg({ reply_to_provider_id: "o2", text: "this one" }), [poll])).toBe("reply_to_atlas");
  });

  it("answering Atlas's question right after is addressed; after a statement it isn't", () => {
    const q = msg({ direction: "outbound", person_id: null, text: "how much was it, and was it shared?" });
    expect(reason(msg({ text: "64, all of us" }, 1), [q])).toBe("answers_question");
    const s = msg({ direction: "outbound", person_id: null, text: "logged $12 for dinner" });
    expect(reason(msg({ text: "cool" }, 1), [s])).toBeNull();
  });

  it("the open question closes after a few human messages or 15 minutes", () => {
    const q = msg({ direction: "outbound", person_id: null, text: "where are we thinking?" });
    const chatter = [msg({ person_id: 2, text: "lol" }), msg({ person_id: 3, text: "same" }), msg({ person_id: 2, text: "haha" })];
    expect(reason(msg({ text: "lisbon" }, 1), [q, ...chatter])).toBeNull();
    expect(reason(msg({ text: "lisbon" }, 20), [q])).toBeNull();
  });

  it("a question aimed at one person only counts as answered by that person", () => {
    const q = msg({ direction: "outbound", person_id: null, text: "priya, what dates work for you?" });
    expect(reason(msg({ person_id: 3, text: "the 12th" }, 1), [q])).toBe("answers_question");
    expect(reason(msg({ person_id: 2, text: "the 12th" }, 1), [q])).toBeNull();
  });

  it("a friend answering a friend's question is not addressed", () => {
    const fq = msg({ person_id: 2, text: "maya when's your flight?" });
    expect(reason(msg({ text: "6pm" }, 1), [fq])).toBeNull();
  });
});

describe("addressedReason: who an open question is for", () => {
  it("a question ending in a name is that person's to answer", () => {
    const q = msg({ direction: "outbound", person_id: null, text: "got it, seattle for zoe.\nwant me to add you to the payment plan, priya?" });
    expect(reason(msg({ person_id: 2, text: "ok" }, 1), [q])).toBeNull();
    expect(reason(msg({ person_id: 3, text: "yes please" }, 1), [q])).toBe("answers_question");
  });
  it("a bare ack to a question for the room answers nothing", () => {
    const q = msg({ direction: "outbound", person_id: null, text: "options? dates?" });
    expect(reason(msg({ person_id: 2, text: "ok" }, 1), [q])).toBeNull();
    expect(reason(msg({ person_id: 2, text: "late jan works" }, 1), [q])).toBe("answers_question");
  });
});
