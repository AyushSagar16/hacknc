// Bank-connect onboarding (docs/plan-trip-stages.md §2). The intro (and a late joiner's welcome)
// asks each person to connect their bank; "yes" gets them a signed link to the consent page on the
// trip site (web/app/connect/[token]); the page calls back POST /connect-callback, and only then is
// a Nessie customer linked and seeded for them (the chat calls it "your capital one"). Anyone who
// says no is asked for a rough budget instead, and anyone who has done neither after a day gets one
// nudge. Everything here is deterministic; the agent only gets `send_connect_link` for fuzzy asks.
import { randomBytes } from "node:crypto";
import type { Config } from "../../config.ts";
import { isoDate, now } from "../../clock.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, getChat, getPerson, labelOf, type MessageRow } from "../../db/repos/core.ts";
import { childLog } from "../../log.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { refreshBudget, setAdjusted } from "../../nessie/budgets.ts";
import { ensureLink, seedPerson } from "../../nessie/seed.ts";
import { rosterPersona } from "../../roster.ts";
import { tripFor } from "../../trips/state.ts";
import { CONNECT_CALLBACK_PATH, signToken, verifyBody, verifyToken } from "../../connect/token.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { ToolError, say, str, type Tool, type ToolCtx } from "../tools.ts";
import { MAX_BUDGET_CENTS, MIN_BUDGET_CENTS } from "./budgets.ts";
import { nameList } from "./planning.ts";

export const CONNECT_QUESTION = "want to connect your capital one so i can plan around real budgets?";
/** How long after the ask a bare "yes"/"no" still answers it. */
const ASK_OPEN_MS = 30 * 60_000;
/** How long after "what's a rough number?" a bare number is read as their budget. */
const BUDGET_ANSWER_MS = 24 * 3_600_000;
/** One nudge for people who neither connected nor gave a budget, about a day after the ask. */
export const NUDGE_AFTER_MS = 24 * 3_600_000;

export type ConnectStatus = "offered" | "link_sent" | "connected" | "declined";

export interface ConnectionRow {
  person_id: number;
  chat_id: number;
  status: ConnectStatus;
  offered_at: Date;
  link_sent_at: Date | null;
  connected_at: Date | null;
  announced_at: Date | null;
  declined_at: Date | null;
  budget_asked_at: Date | null;
  nudged_at: Date | null;
}

// ---------- config fallbacks: never crash on a missing secret or URL ----------

const DEV_SECRET = "atlas-dev-connect-secret";
let processSecret: string | undefined;

/** CONNECT_SECRET; the simulator falls back to a fixed dev secret, a real line to a random one (links won't verify on the site). */
export function connectSecret(cfg: Pick<Config, "CONNECT_SECRET" | "IMESSAGE_MODE">): string {
  if (cfg.CONNECT_SECRET) return cfg.CONNECT_SECRET;
  if (cfg.IMESSAGE_MODE === "sim") return DEV_SECRET;
  if (!processSecret) {
    processSecret = randomBytes(32).toString("base64url");
    childLog({ component: "connect" }).warn("CONNECT_SECRET is not set: connect links are signed with a throwaway secret the site can't verify");
  }
  return processSecret;
}

/** Where the consent page lives (the trip site), or the web dev server. */
export function siteBase(cfg: Pick<Config, "SITE_BASE_URL">): string {
  return cfg.SITE_BASE_URL ?? "http://localhost:3000";
}

/** Atlas's own public URL for the callback (the tunnel under `npm run live`), or the local webhook server. */
export function atlasBase(cfg: Pick<Config, "PUBLIC_BASE_URL" | "LINQ_WEBHOOK_PORT">): string {
  return cfg.PUBLIC_BASE_URL ?? `http://127.0.0.1:${cfg.LINQ_WEBHOOK_PORT}`;
}

export function connectUrl(cfg: Config, personId: number, chatId: number, firstName: string, at: Date): string {
  const token = signToken({ p: personId, c: chatId, n: firstName, cb: atlasBase(cfg) }, connectSecret(cfg), at.getTime());
  return `${siteBase(cfg)}/connect/${token}`;
}

// ---------- store ----------

export async function connectionFor(personId: number, chatId: number): Promise<ConnectionRow | undefined> {
  return one<ConnectionRow>(`SELECT * FROM bank_connections WHERE person_id = $1 AND chat_id = $2`, [personId, chatId]);
}

/** Connected in any chat: their bank (a Nessie customer) is linked once, per person. */
export async function isConnected(personId: number): Promise<boolean> {
  return Boolean(await one(`SELECT 1 FROM bank_connections WHERE person_id = $1 AND status = 'connected' LIMIT 1`, [personId]));
}

/** Record that Atlas asked these people to connect, and schedule the one nudge. */
export async function offerConnect(chatId: number, personIds: number[], at: Date): Promise<void> {
  if (!personIds.length) return;
  await q(
    `INSERT INTO bank_connections (person_id, chat_id, status, offered_at, updated_at)
     SELECT unnest($1::bigint[]), $2, 'offered', $3, $3
     ON CONFLICT (person_id, chat_id) DO NOTHING`,
    [personIds, chatId, at],
  );
  await enqueueJob("connect.nudge", { chatId }, { singletonKey: `connect.nudge:${chatId}`, dueAt: new Date(at.getTime() + NUDGE_AFTER_MS) });
}

async function ensureRow(personId: number, chatId: number, at: Date): Promise<void> {
  await q(
    `INSERT INTO bank_connections (person_id, chat_id, status, offered_at, updated_at) VALUES ($1, $2, 'offered', $3, $3)
     ON CONFLICT (person_id, chat_id) DO NOTHING`,
    [personId, chatId, at],
  );
}

/** `set` may use $3 for the time. */
async function upsertStatus(personId: number, chatId: number, at: Date, set: string): Promise<void> {
  await ensureRow(personId, chatId, at);
  await q(`UPDATE bank_connections SET ${set}, updated_at = $3 WHERE person_id = $1 AND chat_id = $2`, [personId, chatId, at]);
}

/** Idempotent: true only the first time this person connects in this chat. */
export async function markConnected(personId: number, chatId: number, at: Date): Promise<boolean> {
  await ensureRow(personId, chatId, at);
  const row = await one<{ person_id: number }>(
    `UPDATE bank_connections SET status = 'connected', connected_at = $3, updated_at = $3
      WHERE person_id = $1 AND chat_id = $2 AND status <> 'connected' RETURNING person_id`,
    [personId, chatId, at],
  );
  return Boolean(row);
}

// ---------- what people say ----------

const LEAD = String.raw`^\W*(?:(?:hey\s+|ok\s+|okay\s+)?atlas[\s,:!-]*)?`;
const END = String.raw`[\s!.👍🙏✅🔒]*$`;
const YES = new RegExp(
  `${LEAD}(?:y|ya|yes+|yeah|yea|yep|yup|sure|sure thing|ok sure|of course|ofc|absolutely|definitely|please|yes please|yeah sure|sounds good|bet|i'?m down|down|let'?s do it|do it|go for it|send (?:it|me (?:one|the link|a link))|connect me|connect it)${END}`,
  "i",
);
const NO = new RegExp(
  `${LEAD}(?:no+|nah+|nope|no thanks|no thank you|no thx|nah i'?m good|i'?m good|im good|pass|i'?ll pass|not now|not rn|maybe later|later|skip|skip me|i'?d rather not|rather not|no way)${END}`,
  "i",
);
/** Anytime, from anyone: "connect me", "atlas connect my capital one", "how do i connect my bank". */
const CONNECT_ME = /\b(?:connect (?:me|my (?:capital one|cap one|bank|account|card))|(?:send|give) me (?:a|my|the) (?:connect|connection) link|(?:new|another) (?:connect )?link)\b/i;

export const isYes = (text: string) => YES.test(text.trim());
export const isNo = (text: string) => NO.test(text.trim());
export const wantsConnect = (text: string) => CONNECT_ME.test(text);

/** "like 500", "$400", "maybe 1.2k tops" → cents; null when it isn't just a number. */
export function parseRoughBudget(text: string): number | null {
  const m = /^\W*(?:(?:like|about|around|maybe|prob(?:ably)?|roughly|~|max|up to|i'?d say|idk|uh+|um+|hmm+|prolly)[\s,]*)*\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s*(?:bucks|dollars|usd|tops|max|ish|-ish|or so)?[\s!.]*$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Atlas's own connect-flow replies, which don't close the ask ("here's yours maya 🔒", the link). */
function isFlowReply(text: string): boolean {
  return /🔒|connected ✓|\/connect\/|won't connect anything|roughly how much do you want to spend|i'll plan around that 👍/.test(text);
}

/** The connect question is still the open one: Atlas's latest real message asked it, recently. */
function askIsOpen(msg: MessageRow, history: MessageRow[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.direction !== "outbound" || h.id >= msg.id) continue;
    if (isFlowReply(h.text)) continue;
    return h.text.includes(CONNECT_QUESTION) && msg.sent_at.getTime() - h.sent_at.getTime() <= ASK_OPEN_MS;
  }
  return false;
}

const firstName = (tc: Pick<ToolCtx, "label">, id: number) => tc.label(id).toLowerCase().split(/\s+/)[0] ?? "";

/** "here's yours maya 🔒" + the signed link. Already connected: say so instead. */
export async function sendConnectLink(tc: ToolCtx, personId: number): Promise<"sent" | "already"> {
  const name = firstName(tc, personId);
  if (await isConnected(personId)) {
    say(tc, `you're already connected ✓ ${name}`);
    return "already";
  }
  const display = tc.label(personId).split(/\s+/)[0] ?? name;
  const url = connectUrl(tc.cfg, personId, tc.chat.id, display.charAt(0).toUpperCase() + display.slice(1), tc.now);
  say(tc, `here's yours ${name} 🔒`);
  tc.out.push({ type: "link", url, fallbackText: "connect your capital one" });
  await upsertStatus(personId, tc.chat.id, tc.now, "status = 'link_sent', link_sent_at = $3");
  return "sent";
}

async function decline(tc: TurnCtx, personId: number): Promise<void> {
  const name = firstName(tc, personId);
  await upsertStatus(personId, tc.chat.id, tc.now, "status = 'declined', declined_at = $3, budget_asked_at = $3");
  say(tc, `all good ${name}, i won't connect anything`, `${name}, roughly how much do you want to spend on this trip, all in?`);
}

const sendConnectLinkTool: Tool = {
  soloPost: true,
  decl: {
    name: "send_connect_link",
    description:
      "Send someone their secure link to connect their Capital One account, so their trip budget comes from their real spending. Use when a person agrees to connect or asks how to connect. Defaults to the sender. Someone who doesn't want to connect can just tell you a rough budget (set_my_budget).",
    parameters: { type: "object", properties: { name: { type: "string", description: "first name of the person; omit for the sender" } } },
  },
  async run(args, ctx) {
    const who = str(args.name);
    const personId = who ? ctx.resolve(who) : ctx.senderId ?? undefined;
    if (personId === undefined || personId === null) throw new ToolError(who ? `no one called ${who} in this chat` : "no sender");
    const before = ctx.out.length;
    const result = await sendConnectLink(ctx, personId);
    return { ok: true, posted: ctx.out.slice(before).map((a) => (a.type === "say" ? a.text : "")).filter(Boolean), next: result === "already" ? "they're already connected" : "the link was posted; don't repeat it" };
  },
};

// ---------- the callback from the consent page ----------

export interface CallbackResult {
  status: number;
  json: Record<string, unknown>;
}

/**
 * POST /connect-callback. The body is {"token": ...} signed with x-atlas-signature; the token says
 * who and where. Idempotent: a second call for the same person and chat changes nothing.
 * The simulator's `maya connects` runs this same function.
 */
export async function handleConnectCallback(rawBody: string, signature: string | undefined, svc: Pick<AppServices, "cfg">): Promise<CallbackResult> {
  const log = childLog({ component: "connect" });
  const secret = connectSecret(svc.cfg);
  if (!verifyBody(rawBody, signature, secret)) return { status: 401, json: { ok: false, error: "bad_signature" } };
  let token: unknown;
  try {
    token = (JSON.parse(rawBody) as { token?: unknown }).token;
  } catch {
    return { status: 400, json: { ok: false, error: "malformed" } };
  }
  const at = now();
  const verified = verifyToken(typeof token === "string" ? token : "", secret, at.getTime());
  if (!verified.ok) return { status: verified.reason === "expired" ? 410 : 400, json: { ok: false, error: verified.reason } };
  const { p: personId, c: chatId, n: name } = verified.payload;
  const member = await one(`SELECT 1 FROM chat_members WHERE chat_id = $1 AND person_id = $2`, [chatId, personId]);
  if (!member) return { status: 404, json: { ok: false, error: "unknown_person" } };
  const fresh = await markConnected(personId, chatId, at);
  if (fresh) await enqueueJob("connect.complete", { personId, chatId }, { singletonKey: `connect:${personId}:${chatId}` });
  log.info({ personId, chatId, fresh }, "bank connected");
  return { status: 200, json: { ok: true, name, already: !fresh } };
}

export { CONNECT_CALLBACK_PATH };

// ---------- the feature ----------

export const connectFeature: Feature = {
  name: "connect",
  tools: [sendConnectLinkTool],

  async fastPath(msg, tc) {
    if (msg.kind !== "text" || msg.person_id === null || !msg.speakable) return false;
    const personId = msg.person_id;
    const text = msg.text;
    if (wantsConnect(text) && text.length <= 80) {
      await sendConnectLink(tc, personId);
      return true;
    }
    const row = await connectionFor(personId, tc.chat.id);
    if (row?.status !== "connected" && !(await isConnected(personId))) {
      if (askIsOpen(msg, tc.history)) {
        if (isYes(text) && row?.status !== "link_sent") {
          await sendConnectLink(tc, personId);
          return true;
        }
        if (isNo(text) && (!row || row.status === "offered")) {
          await decline(tc, personId);
          return true;
        }
      }
      if (row?.budget_asked_at && msg.sent_at.getTime() - row.budget_asked_at.getTime() <= BUDGET_ANSWER_MS) {
        const cents = parseRoughBudget(text);
        if (cents !== null && cents >= MIN_BUDGET_CENTS && cents <= MAX_BUDGET_CENTS) {
          const budget = await setAdjusted(personId, tc.trip.id, cents);
          await q(`UPDATE bank_connections SET budget_asked_at = NULL, updated_at = $3 WHERE person_id = $1 AND chat_id = $2`, [personId, tc.chat.id, tc.now]);
          say(tc, `got it ${firstName(tc, personId)}, i'll plan around that 👍${budget.visibility === "private" ? " (kept private)" : ""}`);
          return true;
        }
      }
    }
    return false;
  },

  async situation(tc) {
    const rows = new Map((await q<ConnectionRow>(`SELECT * FROM bank_connections WHERE chat_id = $1`, [tc.chat.id])).map((r) => [r.person_id, r]));
    if (rows.size === 0) return null;
    const lines = tc.members.map((m) => {
      const r = rows.get(m.id);
      const state = !r
        ? "not asked yet"
        : r.status === "connected"
          ? "connected ✓"
          : r.status === "link_sent"
            ? "has their link, hasn't connected yet"
            : r.status === "declined"
              ? "doesn't want to connect; ask for a rough budget instead (set_my_budget)"
              : "asked, no answer yet";
      return `- ${tc.label(m.id)}: ${state}`;
    });
    return { title: "capital one connections (budgets come from connected accounts; never say anything else about where the money data comes from)", lines };
  },

  jobs(svc) {
    return {
      // After a connect: link and seed their customer (the same path as nessie.link), compute their
      // budget for the chat's trip, then say so in the group. No figure in the group: budgets are private.
      "connect.complete": async (payload, { jobId }) => {
        const personId = Number(payload.personId);
        const chatId = Number(payload.chatId);
        const person = await getPerson(personId);
        await ensureLink(personId, { persona: person ? rosterPersona(person.handle) : undefined });
        await seedPerson(personId);
        const chat = await getChat(chatId);
        if (!chat) return;
        const trip = await tripFor(chatId);
        await refreshBudget(personId, trip.id, isoDate(now(), chat.timezone), trip.start_date).catch((err) => {
          childLog({ component: "connect" }).warn({ err: (err as Error).message, personId }, "budget not computed after connect");
        });
        const claimed = await one(
          `UPDATE bank_connections SET announced_at = $3, updated_at = $3 WHERE person_id = $1 AND chat_id = $2 AND announced_at IS NULL RETURNING person_id`,
          [personId, chatId, now()],
        );
        if (!claimed) return;
        const name = labelOf(person ?? { display_name: null, handle: null }).toLowerCase().split(/\s+/)[0] ?? "";
        await svc.post(chatId, `connect${jobId}`, [{ type: "say", text: `${name}'s connected ✓` }]);
      },

      // One nudge, about a day after the ask, for whoever neither connected nor gave a budget.
      "connect.nudge": async (payload, { jobId }) => {
        const chatId = Number(payload.chatId);
        const chat = await getChat(chatId);
        if (!chat) return;
        const at = now();
        const members = await activeMembers(chatId);
        const active = new Set(members.map((m) => m.id));
        const rows = (await q<ConnectionRow>(`SELECT * FROM bank_connections WHERE chat_id = $1 AND status <> 'connected' AND nudged_at IS NULL`, [chatId])).filter((r) => active.has(r.person_id));
        const due: ConnectionRow[] = [];
        let next: number | null = null;
        for (const r of rows) {
          if (await isConnected(r.person_id)) continue;
          const stated = await one(
            `SELECT 1 FROM budgets b JOIN trips t ON t.id = b.trip_id WHERE t.chat_id = $1 AND b.person_id = $2 AND b.adjusted_cents IS NOT NULL LIMIT 1`,
            [chatId, r.person_id],
          );
          if (stated) continue;
          const dueAt = r.offered_at.getTime() + NUDGE_AFTER_MS - 60 * 60_000; // "about a day"
          if (dueAt <= at.getTime()) due.push(r);
          else next = Math.min(next ?? Infinity, dueAt);
        }
        if (due.length) {
          const ids = due.map((r) => r.person_id);
          await q(`UPDATE bank_connections SET nudged_at = $3, budget_asked_at = $3, updated_at = $3 WHERE chat_id = $1 AND person_id = ANY($2)`, [chatId, ids, at]);
          if (!chat.quiet_mode) {
            const byId = new Map(members.map((m) => [m.id, m]));
            const names = ids.map((id) => labelOf(byId.get(id) ?? { display_name: null, handle: null }).toLowerCase().split(/\s+/)[0] ?? "").filter(Boolean);
            const text = `${nameList(names)}, i still need a rough budget from you to plan around 🙏\nsay "connect me" to connect your capital one, or just tell me a number`;
            await svc.post(chatId, `connect-nudge${jobId}`, [{ type: "say", text }]);
          }
        }
        if (next !== null) return { rescheduleAt: new Date(next + 60 * 60_000) };
      },
    };
  },
};
