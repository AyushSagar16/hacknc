"use server";
// The Connect button: re-verify the token, then tell Atlas (signed) that this person connected.
// Links that name their Atlas instance are filed in Supabase's connect_events, which that Atlas
// polls, so no inbound connection to it is needed (it may be on a laptop behind a relay). Older
// links without one fall back to calling Atlas back directly.
import { createClient } from "@supabase/supabase-js";
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
  if (check.payload.i) return (await fileApproval(check.payload.i, token, signature)) ? { status: "connected", name: check.payload.n } : { status: "unreachable" };
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

async function fileApproval(instance: string, token: string, signature: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.from("connect_events").insert({ instance, token, signature });
  if (error) console.error(`connect_events insert failed: ${error.message}`);
  return !error;
}
