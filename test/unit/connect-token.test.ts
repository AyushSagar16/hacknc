import { describe, expect, it } from "vitest";
import { CONNECT_TOKEN_TTL_SECONDS, signBody, signToken, verifyBody, verifyToken } from "../../src/connect/token.ts";
import { isNo, isYes, parseRoughBudget, wantsConnect } from "../../src/agent/features/connect.ts";

const SECRET = "test-secret";
const NOW = Date.UTC(2026, 9, 10, 18, 0, 0);
const base = { p: 7, c: 3, n: "Maya", cb: "https://atlas.example.com" };

describe("connect token", () => {
  it("round-trips the payload and expires after 48 h", () => {
    const token = signToken(base, SECRET, NOW);
    const v = verifyToken(token, SECRET, NOW);
    expect(v).toEqual({ ok: true, payload: { v: 1, ...base, exp: NOW / 1000 + CONNECT_TOKEN_TTL_SECONDS } });
    expect(CONNECT_TOKEN_TTL_SECONDS).toBe(48 * 3600);
    expect(verifyToken(token, SECRET, NOW + 47 * 3_600_000).ok).toBe(true);
    expect(verifyToken(token, SECRET, NOW + 48 * 3_600_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("is base64url(json).base64url(hmac) and url-safe", () => {
    const token = signToken(base, SECRET, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [body] = token.split(".");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString("utf8"))).toMatchObject({ v: 1, p: 7, c: 3, n: "Maya" });
  });

  it("rejects a tampered payload, a wrong secret and garbage", () => {
    const token = signToken(base, SECRET, NOW);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, ...base, p: 8, exp: NOW / 1000 + 3600 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToken(token, "other-secret", NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToken(`${token}x`, SECRET, NOW).ok).toBe(false);
    expect(verifyToken("not-a-token", SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("", SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("an expired token with a valid signature still reads as expired, not invalid", () => {
    const token = signToken({ ...base, exp: NOW / 1000 - 1 }, SECRET, NOW);
    expect(verifyToken(token, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("signs and verifies callback bodies", () => {
    const body = JSON.stringify({ token: signToken(base, SECRET, NOW) });
    const sig = signBody(body, SECRET);
    expect(verifyBody(body, sig, SECRET)).toBe(true);
    expect(verifyBody(`${body} `, sig, SECRET)).toBe(false);
    expect(verifyBody(body, sig, "other")).toBe(false);
    expect(verifyBody(body, undefined, SECRET)).toBe(false);
  });
});

describe("connect replies", () => {
  it("reads yes, no and connect requests", () => {
    for (const t of ["yes", "Yes!", "yeah", "sure", "yep 👍", "atlas yes", "let's do it", "connect me"]) expect(isYes(t), t).toBe(true);
    for (const t of ["ok", "cool", "yes but where are we going", "lol"]) expect(isYes(t), t).toBe(false);
    for (const t of ["no", "nah", "no thanks", "i'm good", "not now", "pass"]) expect(isNo(t), t).toBe(true);
    for (const t of ["no way that's so cheap!", "nah lisbon is better"]) expect(isNo(t), t).toBe(false);
    for (const t of ["connect me", "atlas connect my capital one", "can you connect my bank?"]) expect(wantsConnect(t), t).toBe(true);
    expect(wantsConnect("the flights connect in atlanta")).toBe(false);
  });

  it("parses a rough budget only when the message is just a number", () => {
    expect(parseRoughBudget("like 600")).toBe(60_000);
    expect(parseRoughBudget("$450")).toBe(45_000);
    expect(parseRoughBudget("maybe 1.2k tops")).toBe(120_000);
    expect(parseRoughBudget("1,500")).toBe(150_000);
    expect(parseRoughBudget("i have 3 roommates")).toBeNull();
    expect(parseRoughBudget("march 7")).toBeNull();
  });
});
