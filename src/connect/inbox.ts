// Bank-connect approvals filed by the trip site in Supabase's connect_events, for this Atlas
// instance. Polled, so nothing has to reach Atlas from the internet: it works behind the linq
// relay with no tunnel. Each row goes through the same signed check as POST /connect-callback
// (handleConnectCallback, idempotent), then gets processed_at and the result stamped on it.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.ts";
import { childLog } from "../log.ts";
import { handleConnectCallback } from "../agent/features/connect.ts";

const POLL_MS = 3_000;
const TIMEOUT_MS = 8_000;

interface EventRow {
  id: number;
  token: string;
  signature: string;
}

export interface ConnectInbox {
  stop(): void;
}

/** Starts polling when Supabase is configured; undefined otherwise. */
export function startConnectInbox(cfg: Config, instanceId: string | undefined): ConnectInbox | undefined {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY || !instanceId) return undefined;
  const log = childLog({ component: "connect" });
  const db: SupabaseClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }) },
  });
  let stopped = false;
  let warned = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    const { data, error } = await db
      .from("connect_events")
      .select("id, token, signature")
      .eq("instance", instanceId)
      .is("processed_at", null)
      .order("id")
      .limit(20);
    if (error) {
      // Logged once until it recovers: a missing table or a network blip shouldn't flood the log.
      if (!warned) log.warn({ err: error.message }, "connect inbox unavailable");
      warned = true;
      return;
    }
    warned = false;
    for (const row of (data ?? []) as EventRow[]) {
      const result = await handleConnectCallback(JSON.stringify({ token: row.token }), row.signature, { cfg });
      const { error: markError } = await db
        .from("connect_events")
        .update({ processed_at: new Date().toISOString(), result: { status: result.status, ...result.json } })
        .eq("id", row.id);
      if (markError) log.warn({ err: markError.message, id: row.id }, "connect event not marked processed");
    }
  };

  const loop = async () => {
    await tick().catch((err) => log.warn({ err: (err as Error).message }, "connect inbox poll failed"));
    if (!stopped) timer = setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
  log.info({ instance: instanceId }, "connect inbox polling supabase");
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
