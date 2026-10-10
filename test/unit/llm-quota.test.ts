import { describe, expect, it } from "vitest";
import { isSmallTalk } from "../../src/agent/smallTalk.ts";
import { LlmError, benchMs } from "../../src/agent/llm.ts";

describe("benchMs", () => {
  const quota = (details: string) =>
    new Error(`{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[${details}]}}`);

  it("waits out a daily quota instead of retrying every two minutes", () => {
    expect(benchMs(quota(`{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}`))).toBe(30 * 60_000);
  });

  it("honors RetryInfo on a per-minute quota", () => {
    expect(benchMs(quota(`{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"retryDelay":"41s"}`))).toBe(41_000);
    expect(benchMs(quota(`{"retryDelay":"2s"}`))).toBe(15_000);
  });

  it("keeps the overload, timeout and not-found schedules", () => {
    expect(benchMs(new Error("503 UNAVAILABLE high demand"))).toBe(2 * 60_000);
    expect(benchMs(new LlmError("gemini x agent call timed out after 12000ms", "timeout"))).toBe(3 * 60_000);
    expect(benchMs(new Error("404 models/x is not found"))).toBe(60 * 60_000);
  });
});

describe("isSmallTalk", () => {
  it.each(["lol", "LMAO", "hahahaha", "lolol", "ok 👍", "😂😂", "!!", "omg nice", "bruh", "lmaooo 😂", "omggg", "hahaa", "niceee"])("%s is small talk", (t) => {
    expect(isSmallTalk(t)).toBe(true);
  });

  it.each(["same", "yeah", "no", "i'm vegetarian", "lol cancun is too pricey", "ok i'm in for nov 12", "64", "atlas"])("%s still goes to the models", (t) => {
    expect(isSmallTalk(t)).toBe(false);
  });
});
