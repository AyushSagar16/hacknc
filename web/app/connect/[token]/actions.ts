"use server";
// The Connect button: re-verify the token, then tell Atlas (signed) that this person connected.
import { signCallbackBody, verifyConnectToken } from "@/lib/connectToken";

export type ConnectState =
  | { status: "idle" }
  | { status: "connected"; name: string }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "unreachable" };

export async function connectAction(_prev: ConnectState, form: FormData): Promise<ConnectState> {
  const token = String(form.get("token") ?? "");
  const check = verifyConnectToken(token);
  if (!check.ok) return { status: check.reason === "expired" ? "expired" : "invalid" };
  const body = JSON.stringify({ token });
  const signature = signCallbackBody(body);
  if (!signature) return { status: "invalid" };
  try {
    const res = await fetch(`${check.payload.cb.replace(/\/+$/, "")}/connect-callback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atlas-signature": signature },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: "connected", name: check.payload.n };
    if (res.status === 410) return { status: "expired" };
    if (res.status === 400 || res.status === 401 || res.status === 404) return { status: "invalid" };
    return { status: "unreachable" };
  } catch {
    return { status: "unreachable" };
  }
}
