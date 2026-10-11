import { describe, expect, it } from "vitest";
import { maskHandle, prettyLine, preview } from "../../src/log.ts";
import { classifySendError } from "../../src/pipeline/pipeline.ts";
import { LinqApiError } from "../../src/transport/linq/api.ts";
import { straightQuotes } from "../../src/transport/inbound.ts";

describe("send error classification", () => {
  it("linq 403 code 2006 (no permission to send from this number) is permanent for the whole chat", () => {
    const err = new LinqApiError("/chats/x/messages", 403, '{"error":{"code":2006,"message":"You do not have permission to send from this phone number"}}');
    expect(classifySendError(err)).toEqual({ permanent: true, chatWide: true, status: 403, code: 2006 });
    // The same error after Spectrum flattened it to a message.
    expect(classifySendError(new Error(err.message))).toMatchObject({ permanent: true, chatWide: true, status: 403, code: 2006 });
  });
  it("a bad request fails that one message; rate limits, 5xx and network errors retry", () => {
    expect(classifySendError(new LinqApiError("/x", 400, "{}"))).toMatchObject({ permanent: true, chatWide: false });
    expect(classifySendError(new LinqApiError("/x", 429, "{}")).permanent).toBe(false);
    expect(classifySendError(new LinqApiError("/x", 503, "{}")).permanent).toBe(false);
    expect(classifySendError(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })).permanent).toBe(false);
  });
});

describe("log helpers", () => {
  it("masks handles to the last 4 and previews text on one line", () => {
    expect(maskHandle("+15551234567")).toBe("…4567");
    expect(maskHandle("maya.r@example.com")).toBe("…ya.r".slice(-5));
    expect(maskHandle(null)).toBe("");
    expect(preview("a\nb   c")).toBe("a b c");
    expect(preview("x".repeat(80))).toHaveLength(60);
  });
  it("prints one readable line per pino event", () => {
    const line = prettyLine(JSON.stringify({ level: 30, time: Date.UTC(2026, 9, 11, 15, 53, 56), component: "pipeline", chatId: 73, msgId: 189, from: "Sakshi …4521", text: "i'm driving from unc chapel hill", msg: "inbound" }));
    expect(line).toMatch(/^\d\d:\d\d:\d\d {2}INFO {3}pipeline {3}inbound {2}chat=73 msg=189 from="Sakshi …4521" text="i'm driving from unc chapel hill"\n$/);
    expect(prettyLine("not json")).toBe("not json\n");
  });
});

describe("inbound text", () => {
  it("straightens iPhone smart quotes so commands and triggers match", () => {
    expect(straightQuotes("what\u2019s our budget? \u201cbook it\u201d")).toBe(`what's our budget? "book it"`);
  });
});
