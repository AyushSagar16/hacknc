import { describe, expect, it } from "vitest";
import { signForTest, verifySignature } from "../../src/transport/linq/webhook.ts";

const secret = `whsec_${Buffer.from("super-secret-key-material").toString("base64")}`;
const now = new Date("2026-10-10T18:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ event_type: "message.received", event_id: "evt_1", data: {} });

describe("Standard Webhooks signature verification", () => {
  it("accepts a valid signature", () => {
    const signature = signForTest(secret, "msg_1", ts, body);
    expect(verifySignature({ secret, id: "msg_1", timestamp: ts, signature, body, now })).toEqual({ ok: true });
  });

  it("accepts when one of several signatures matches (key rotation)", () => {
    const good = signForTest(secret, "msg_1", ts, body);
    expect(verifySignature({ secret, id: "msg_1", timestamp: ts, signature: `v1,AAAA ${good}`, body, now }).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = signForTest(secret, "msg_1", ts, body);
    expect(verifySignature({ secret, id: "msg_1", timestamp: ts, signature, body: body.replace("evt_1", "evt_2"), now })).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a replayed id with a different signature id", () => {
    const signature = signForTest(secret, "msg_1", ts, body);
    expect(verifySignature({ secret, id: "msg_2", timestamp: ts, signature, body, now }).ok).toBe(false);
  });

  it("rejects old timestamps (replay window)", () => {
    const old = String(Math.floor(now.getTime() / 1000) - 3600);
    const signature = signForTest(secret, "msg_1", old, body);
    expect(verifySignature({ secret, id: "msg_1", timestamp: old, signature, body, now })).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("rejects missing headers and the wrong secret", () => {
    expect(verifySignature({ secret, id: undefined, timestamp: ts, signature: "v1,x", body, now }).ok).toBe(false);
    const signature = signForTest(`whsec_${Buffer.from("other").toString("base64")}`, "msg_1", ts, body);
    expect(verifySignature({ secret, id: "msg_1", timestamp: ts, signature, body, now }).ok).toBe(false);
  });
});
