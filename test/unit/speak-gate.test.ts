import { describe, expect, it } from "vitest";
import { readVerdict } from "../../src/agent/speakGate.ts";

describe("readVerdict", () => {
  it("reads clean JSON", () => {
    expect(readVerdict('{"decision":"SPEAK","reason":"trip question"}')).toEqual({ decision: "SPEAK", reason: "trip question" });
  });
  it("reads JSON wrapped in prose or a code fence (seen from a failover model)", () => {
    expect(readVerdict('Here is the JSON:\n```json\n{"decision": "NO_REPLY", "reason": "banter"}\n```')).toEqual({ decision: "NO_REPLY", reason: "banter" });
  });
  it("falls back to a bare decision word, and gives up on nonsense", () => {
    expect(readVerdict('{"decision": "SPEAK", "reason": "cut off')?.decision).toBe("SPEAK");
    expect(readVerdict("H")).toBeNull();
    expect(readVerdict("")).toBeNull();
  });
  it("keeps long reasons instead of rejecting them", () => {
    expect(readVerdict(JSON.stringify({ decision: "SPEAK", reason: "x".repeat(300) }))?.reason).toHaveLength(200);
  });
});
