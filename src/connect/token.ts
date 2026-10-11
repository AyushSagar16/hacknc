// Signed bank-connect links and callbacks (docs/plan-trip-stages.md §2).
//   token  = base64url(json) "." base64url(HMAC-SHA256(CONNECT_SECRET, json))
//   payload  { v: 1, p: personId, c: chatId, n: firstName, cb: atlasPublicBaseUrl, exp: epochSeconds }
// The web consent page (web/lib/connectToken.ts is a copy of this file's logic) verifies the
// token, then POSTs {"token": ...} to `${cb}/connect-callback` with `x-atlas-signature` =
// base64url(HMAC-SHA256(CONNECT_SECRET, rawBody)). Atlas checks both before marking anyone connected.
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONNECT_TOKEN_TTL_SECONDS = 48 * 3_600;
export const CONNECT_CALLBACK_PATH = "/connect-callback";
export const SIGNATURE_HEADER = "x-atlas-signature";

export interface ConnectPayload {
  v: 1;
  /** Atlas person id. */
  p: number;
  /** Atlas chat id the link was sent in. */
  c: number;
  /** First name, shown on the consent page ("Connecting as Maya"). */
  n: string;
  /** Atlas's public base URL; the consent page calls back `${cb}/connect-callback`. */
  cb: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export type VerifyResult = { ok: true; payload: ConnectPayload } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signToken(payload: Omit<ConnectPayload, "v" | "exp"> & { exp?: number }, secret: string, nowMs: number): string {
  const full: ConnectPayload = { v: 1, p: payload.p, c: payload.c, n: payload.n, cb: payload.cb, exp: payload.exp ?? Math.floor(nowMs / 1000) + CONNECT_TOKEN_TTL_SECONDS };
  const json = JSON.stringify(full);
  return `${b64url(json)}.${b64url(hmac(secret, json))}`;
}

export function verifyToken(token: string, secret: string, nowMs: number): VerifyResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let json: string;
  try {
    json = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!safeEqual(Buffer.from(parts[1], "base64url"), hmac(secret, json))) return { ok: false, reason: "bad_signature" };
  let payload: ConnectPayload;
  try {
    payload = JSON.parse(json) as ConnectPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.v !== 1 || !Number.isInteger(payload.p) || !Number.isInteger(payload.c) || typeof payload.n !== "string" || typeof payload.cb !== "string" || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** `x-atlas-signature` for a callback body. */
export function signBody(body: string, secret: string): string {
  return b64url(hmac(secret, body));
}

export function verifyBody(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  return safeEqual(Buffer.from(signature, "base64url"), hmac(secret, body));
}
