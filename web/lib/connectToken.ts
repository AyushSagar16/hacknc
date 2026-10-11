// Bank-connect link tokens, verified server-side. A copy of the logic in Atlas's
// src/connect/token.ts (keep the two in step):
//   token = base64url(json) "." base64url(HMAC-SHA256(CONNECT_SECRET, json))
//   payload { v: 1, p: personId, c: chatId, n: firstName, cb: atlasPublicBaseUrl, exp: epochSeconds }
// The callback to Atlas is POST `${cb}/connect-callback` with body {"token": ...} and
// `x-atlas-signature` = base64url(HMAC-SHA256(CONNECT_SECRET, body)).
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ConnectPayload {
  v: 1;
  p: number;
  c: number;
  n: string;
  cb: string;
  exp: number;
}

export type TokenCheck = { ok: true; payload: ConnectPayload } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_configured" };

/** Matches Atlas's simulator fallback, so links from `npm run sim` open on `npm run web:dev`. */
const DEV_SECRET = "atlas-dev-connect-secret";

function secret(): string | undefined {
  const s = process.env.CONNECT_SECRET?.trim();
  if (s) return s;
  return process.env.NODE_ENV === "production" ? undefined : DEV_SECRET;
}

const hmac = (key: string, data: string) => createHmac("sha256", key).update(data).digest();
const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function verifyConnectToken(token: string, nowMs = Date.now()): TokenCheck {
  const key = secret();
  if (!key) return { ok: false, reason: "not_configured" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const json = Buffer.from(parts[0], "base64url").toString("utf8");
  if (!safeEqual(Buffer.from(parts[1], "base64url"), hmac(key, json))) return { ok: false, reason: "bad_signature" };
  let payload: ConnectPayload;
  try {
    payload = JSON.parse(json) as ConnectPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.v !== 1 || typeof payload.n !== "string" || typeof payload.cb !== "string" || !/^https?:\/\//.test(payload.cb) || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** `x-atlas-signature` for a callback body; undefined when no secret is configured. */
export function signCallbackBody(body: string): string | undefined {
  const key = secret();
  return key ? hmac(key, body).toString("base64url") : undefined;
}
