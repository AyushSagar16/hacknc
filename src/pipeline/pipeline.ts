// The message pipeline. Inbound messages are stored first (deduped per chat), then each chat
// runs its own debounced turn: drain the unclaimed messages, think, enqueue outgoing actions,
// flush them in order with stable client GUIDs. A message that arrives mid-turn cancels the
// turn (unless a money tool already ran or a bubble already went out) and its messages are
// released back to the queue — carry-forward without a second table.
//
// Cadence: once the brain decides to reply it calls input.typing(), and the typing indicator stays
// up while it thinks. Each bubble then waits a pause scaled to its length (typing shown again
// between bubbles), so a multi-bubble reply arrives like a person texting, not as a burst.
import type { Message, Space } from "spectrum-ts";
import type { Config } from "../config.ts";
import { now } from "../clock.ts";
import { childLog } from "../log.ts";
import { one, q, tx } from "../db/pool.ts";
import {
  activeMembers,
  chatsWithUnclaimed,
  claimUnclaimed,
  deactivateMember,
  ensureMember,
  getChat,
  hasUnclaimed,
  insertMessage,
  releaseClaim,
  upsertChat,
  upsertPerson,
  type ChatRow,
  type MessageRow,
} from "../db/repos/core.ts";
import { normalize, type InboundEvent } from "../transport/inbound.ts";
import { render, type Action } from "../transport/outbound.ts";
import { enqueueJob, recordJobFailure } from "./jobs.ts";
import { logSent, restates } from "../memory/atlasLog.ts";
import { markWebhookProcessed } from "./webhookStore.ts";

export interface TurnInput {
  chat: ChatRow;
  turnId: number;
  batch: MessageRow[];
  signal: AbortSignal;
  /** Call before any side effect that must not be repeated (money, Nessie writes). */
  nonCancellable(): Promise<void>;
  /** Set when nothing new arrived and Atlas was asked to follow up on its own (why, for the agent). */
  nudge?: string;
  /**
   * Call once the turn has decided to reply (before the slow agent call): shows the typing
   * indicator until the first bubble goes out. A turn that ends silent has it cleared. Never throws.
   */
  typing?(): void;
}

export interface TurnResult {
  actions: Action[];
  route: string;
  addressed?: boolean;
  gate?: { decision: string; reason: string };
}

export type TurnHandler = (input: TurnInput) => Promise<TurnResult>;

export interface PipelineOptions {
  handler: TurnHandler;
  resolveSpace: (chat: ChatRow) => Promise<Space>;
  debounceMs?: number;
  maxWaitMs?: number;
  /**
   * Milliseconds to pause before a text bubble (a person types; 0 in tests). index counts the
   * bubbles of one flush, so 0 is the first; time already spent showing typing is taken off it.
   * Tapbacks and polls never pause.
   */
  pacing?: (text: string, index: number) => number;
  /**
   * Shows or clears the typing indicator. Defaults to the Space's startTyping()/stopTyping() (Linq:
   * POST/DELETE /chats/{id}/typing; the simulator no-ops). false turns typing off. Errors are swallowed.
   */
  typing?: false | ((space: Space, on: boolean) => Promise<void>);
  /** Atlas's name. A message that names Atlas and reads complete gets the shorter quiet window. */
  agentName?: string;
  /** Quiet window for such a message (default 1.5 s; never longer than debounceMs). */
  addressedDebounceMs?: number;
  /** Seconds after which a delivered message is too old to answer (still extracted). */
  staleAfterSeconds?: number;
  /** Known display names by handle (demo roster, simulator). */
  names?: (handle: string) => string | undefined;
  onNewMember?: (chatId: number, personId: number) => void | Promise<void>;
}

class Cancelled extends Error {}

/** Never wait longer than this on a typing call before sending (a slow indicator must not delay a reply). */
const TYPING_TIMEOUT_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves when p settles or after ms, whichever is first; never rejects. */
const settleWithin = (p: Promise<unknown>, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => (clearTimeout(t), resolve()),
      () => (clearTimeout(t), resolve()),
    );
  });

/** Pacing from config: base + per-char, clamped; the first bubble is capped shorter (thinking already took time). */
export function pacingFromConfig(cfg: Pick<Config, "PACING" | "PACE_BASE_MS" | "PACE_MS_PER_CHAR" | "PACE_MIN_MS" | "PACE_MAX_MS" | "PACE_FIRST_MAX_MS">): (text: string, index: number) => number {
  if (cfg.PACING === "off") return () => 0;
  return (text, index) => {
    const ms = Math.max(cfg.PACE_MIN_MS, Math.min(cfg.PACE_MAX_MS, cfg.PACE_BASE_MS + cfg.PACE_MS_PER_CHAR * text.length));
    return index === 0 ? Math.min(ms, cfg.PACE_FIRST_MAX_MS) : ms;
  };
}

/** The text a person would have to type for this action, or null when it goes out instantly (tapback, poll). */
function typedText(action: Action): string | null {
  switch (action.type) {
    case "say":
      return action.text;
    case "link":
      return action.fallbackText ?? "";
    default:
      return null;
  }
}

/**
 * A text that names Atlas and reads like a finished request ("atlas what's our budget?"), as opposed to
 * a bare "atlas" or "hey atlas" that's usually followed by the actual ask a second later.
 */
export function namesAgentComplete(text: string, agentName: string): boolean {
  const name = agentName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!name) return false;
  const t = text.toLowerCase();
  if (!new RegExp(`(^|[^a-z0-9])@?${name}([^a-z0-9]|$)`).test(t)) return false;
  const rest = t.replace(new RegExp(`@?${name}`, "g"), " ").match(/[a-z0-9']+/g) ?? [];
  const words = rest.filter((w) => !["hey", "hi", "yo", "ok", "okay"].includes(w));
  return words.length >= 3 || (words.length >= 1 && /\?\s*$/.test(t));
}

interface ChatState {
  key: string;
  chatId?: number;
  timer?: NodeJS.Timeout;
  firstPendingAt?: number;
  running?: { turnId: number; abort: AbortController; cancellable: boolean; done: Promise<void> };
  flushing: Promise<void>;
  expected: number;
  waiters: (() => void)[];
  membersRefreshedAt?: number;
  /** A follow-up was requested; the next turn runs even with no new messages. */
  nudge?: string;
  /** We last told the platform typing is on (and no bubble has gone out since). */
  typingOn?: boolean;
  /** When the current typing stretch started (shortens the first bubble's pause). */
  typingSince?: number;
  /** The last typing call in flight; sends wait for it so a late "start" never lands after a bubble. */
  typingCall?: Promise<void>;
}

export class Pipeline {
  private readonly states = new Map<string, ChatState>();
  private readonly byChatId = new Map<number, ChatState>();
  private readonly spaces = new Map<number, Space>();
  private readonly log = childLog({ component: "pipeline" });
  /** Turns that spoke without being asked (follow-ups, chime-ins): logged as such in atlas_log. */
  private readonly unpromptedTurns = new Set<number>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly staleAfterMs: number;
  private readonly addressedDebounceMs: number;
  private readonly agentName: string;

  constructor(private readonly opts: PipelineOptions) {
    this.debounceMs = opts.debounceMs ?? 2_500;
    this.maxWaitMs = opts.maxWaitMs ?? 8_000;
    this.staleAfterMs = (opts.staleAfterSeconds ?? 300) * 1_000;
    this.addressedDebounceMs = Math.min(opts.addressedDebounceMs ?? 1_500, this.debounceMs);
    this.agentName = opts.agentName ?? "atlas";
  }

  // ---------- inbound ----------

  /** Called for every [space, message] from Spectrum. Never throws. */
  async ingest(space: Space, message: Message): Promise<void> {
    const event = normalize(space, message, now());
    const st = event.kind === "ignored" ? undefined : this.state(`${event.platform}:${event.chatId}`);
    try {
      if (event.kind === "ignored") {
        if (event.eventId) await markWebhookProcessed(event.eventId, event.reason);
        return;
      }
      const stored = await this.store(event, space);
      if (event.eventId) await markWebhookProcessed(event.eventId);
      if (stored && st) this.bump(st, event.kind === "text" && stored.speakable && namesAgentComplete(event.text, this.agentName));
    } catch (err) {
      this.log.error({ err: (err as Error).message, kind: event.kind }, "failed to store inbound message");
      await recordJobFailure("ingest", null, { event }, err);
    } finally {
      if (st && st.expected > 0) st.expected -= 1;
      if (st) this.checkIdle(st);
    }
  }

  private async store(event: Exclude<InboundEvent, { kind: "ignored" }>, space: Space): Promise<MessageRow | undefined> {
    const at = now();
    const newMembers: number[] = [];
    const result = await tx(async (client) => {
      const chat = await upsertChat(event.platform, event.chatId, event.isGroup, at, client);
      const st = this.state(`${event.platform}:${event.chatId}`);
      st.chatId = chat.id;
      this.byChatId.set(chat.id, st);
      this.spaces.set(chat.id, space);

      const person = async (handle: string) => {
        const p = await upsertPerson(handle, at, this.opts.names?.(handle), client);
        if (await ensureMember(chat.id, p.id, at, client)) newMembers.push(p.id);
        return p;
      };

      const base = {
        chatId: chat.id,
        providerMessageId: event.providerMessageId,
        direction: "inbound" as const,
        sentAt: event.sentAt,
        receivedAt: event.receivedAt,
        speakable: at.getTime() - event.sentAt.getTime() < this.staleAfterMs,
      };

      switch (event.kind) {
        case "membership": {
          const actor = event.actor ? await person(event.actor) : undefined;
          const names: string[] = [];
          for (const handle of event.handles) {
            if (event.change === "removed") {
              const p = await upsertPerson(handle, at, this.opts.names?.(handle), client);
              await deactivateMember(chat.id, p.id, at, client);
              names.push(p.display_name ?? handle);
            } else {
              const p = await person(handle);
              names.push(p.display_name ?? handle);
            }
          }
          const text =
            event.change === "joined"
              ? "(atlas was added to the group)"
              : event.change === "added"
                ? `(${names.join(", ")} joined the group)`
                : `(${names.join(", ")} left the group)`;
          return insertMessage({ ...base, personId: actor?.id ?? null, kind: "membership", text, meta: { change: event.change, handles: event.handles } }, client);
        }
        case "text": {
          const p = await person(event.sender);
          return insertMessage(
            { ...base, personId: p.id, kind: "text", text: event.text, replyToProviderId: event.replyToId ?? null, meta: { hasMedia: event.hasMedia } },
            client,
          );
        }
        case "reaction": {
          const p = await person(event.sender);
          const label = event.tapback ?? event.emoji;
          return insertMessage(
            {
              ...base,
              personId: p.id,
              kind: "reaction",
              text: `(${event.removed ? "removed " : ""}${label} tapback)`,
              meta: { targetId: event.targetId, emoji: event.emoji, tapback: event.tapback ?? null, removed: event.removed },
            },
            client,
          );
        }
        case "poll_vote": {
          const p = await person(event.sender);
          return insertMessage(
            {
              ...base,
              personId: p.id,
              kind: "poll_vote",
              text: `(${event.selected ? "voted" : "took back a vote for"} "${event.optionTitle}")`,
              meta: { pollMessageId: event.pollMessageId ?? null, optionTitle: event.optionTitle, pollOptions: event.pollOptions, selected: event.selected },
            },
            client,
          );
        }
      }
    });
    const chatId = this.state(`${event.platform}:${event.chatId}`).chatId!;
    for (const personId of newMembers) await this.opts.onNewMember?.(chatId, personId);
    await this.refreshMembers(chatId, space);
    return result;
  }

  /** Learn members who haven't spoken yet (Linq, sim). Throttled; unsupported platforms are fine. */
  private async refreshMembers(chatId: number, space: Space): Promise<void> {
    const st = this.byChatId.get(chatId);
    if (!st || (st.membersRefreshedAt && Date.now() - st.membersRefreshedAt < 10 * 60_000)) return;
    st.membersRefreshedAt = Date.now();
    try {
      const users = await space.getMembers();
      const at = now();
      for (const user of users) {
        const p = await upsertPerson(user.id, at, this.opts.names?.(user.id));
        if (await ensureMember(chatId, p.id, at)) await this.opts.onNewMember?.(chatId, p.id);
      }
    } catch {
      // Local iMessage and shared cloud lines can't list members; we learn them as they speak.
    }
  }

  // ---------- scheduling ----------

  private state(key: string): ChatState {
    let st = this.states.get(key);
    if (!st) {
      st = { key, flushing: Promise.resolve(), expected: 0, waiters: [] };
      this.states.set(key, st);
    }
    return st;
  }

  /** urgent: the newest message names Atlas and reads complete, so wait the shorter quiet window. */
  private bump(st: ChatState, urgent = false): void {
    if (st.running) {
      if (st.running.cancellable) st.running.abort.abort();
      return; // the running turn reschedules when it ends
    }
    if (st.timer) clearTimeout(st.timer);
    const t = Date.now();
    st.firstPendingAt ??= t;
    const quiet = urgent ? this.addressedDebounceMs : this.debounceMs;
    const delay = Math.max(0, Math.min(quiet, this.maxWaitMs - (t - st.firstPendingAt)));
    st.timer = setTimeout(() => void this.runTurn(st), delay);
  }

  /** Run a turn with no new messages so Atlas can follow up on its own (an idle group, a restart). */
  async nudge(chatId: number, reason: string): Promise<void> {
    const chat = await getChat(chatId);
    if (!chat) return;
    const st = this.state(`${chat.platform}:${chat.provider_chat_id}`);
    st.chatId = chat.id;
    this.byChatId.set(chat.id, st);
    // A turn already running is talking to the group; never cancel it for a follow-up. Keep the
    // request though: if that turn only replays stale messages (extraction only, never answered,
    // e.g. right after boot), the follow-up runs once it ends; if it answers something, it's dropped.
    if (st.running || st.timer) {
      st.nudge ??= reason;
      return;
    }
    st.nudge = reason;
    this.bump(st);
  }

  /** Schedule a turn for a chat now (proactive work, boot recovery). */
  async poke(chatId: number): Promise<void> {
    const chat = await getChat(chatId);
    if (!chat) return;
    const st = this.state(`${chat.platform}:${chat.provider_chat_id}`);
    st.chatId = chat.id;
    this.byChatId.set(chat.id, st);
    this.bump(st);
  }

  private async runTurn(st: ChatState): Promise<void> {
    st.timer = undefined;
    st.firstPendingAt = undefined;
    const chatId = st.chatId;
    if (chatId === undefined) return;
    const chat = await getChat(chatId);
    if (!chat) return;
    const started = now();
    const turn = await one<{ id: number }>(`INSERT INTO turns (chat_id, started_at) VALUES ($1, $2) RETURNING id`, [chatId, started]);
    const turnId = turn!.id;
    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    st.running = { turnId, abort, cancellable: true, done };
    const t0 = Date.now();
    let answers = false;
    try {
      const batch = await claimUnclaimed(chatId, turnId);
      // New messages win over a follow-up: the turn answers them instead. Stale replays don't count.
      answers = batch.some((m) => m.speakable);
      const nudge = batch.length === 0 ? st.nudge : undefined;
      if (batch.length === 0) st.nudge = undefined;
      if (batch.length === 0 && !nudge) {
        await q(`UPDATE turns SET status='done', route='empty', finished_at=$2 WHERE id=$1`, [turnId, now()]);
        return;
      }
      const result = await this.opts.handler({
        chat,
        turnId,
        batch,
        nudge,
        signal: abort.signal,
        typing: () => {
          if (!abort.signal.aborted) void this.setTyping(st, chatId, true);
        },
        nonCancellable: async () => {
          if (st.running) st.running.cancellable = false;
          await q(`UPDATE turns SET cancellable = false WHERE id = $1`, [turnId]);
        },
      });
      if (abort.signal.aborted && st.running?.cancellable) throw new Cancelled();
      if (!result.addressed && (result.route === "agent" || result.route === "nudge")) {
        this.unpromptedTurns.add(turnId);
        result.actions = await this.dropRestated(chatId, turnId, result.actions);
      }
      await this.enqueue(chatId, `t${turnId}`, result.actions, turnId);
      await this.flush(chatId, { turnId, signal: abort.signal, onFirstSend: () => st.running && (st.running.cancellable = false) });
      await q(
        `UPDATE turns SET status='done', route=$2, addressed=$3, gate_decision=$4, gate_reason=$5, finished_at=$6, latency_ms=$7 WHERE id=$1`,
        [turnId, result.route, result.addressed ?? null, result.gate?.decision ?? null, result.gate?.reason ?? null, now(), Date.now() - t0],
      );
    } catch (err) {
      if (err instanceof Cancelled || abort.signal.aborted) {
        if (st.running?.cancellable !== false) {
          await releaseClaim(turnId);
          await q(`UPDATE outbox SET status='skipped' WHERE turn_id=$1 AND status='pending'`, [turnId]);
          await q(`UPDATE turns SET status='cancelled', finished_at=$2 WHERE id=$1`, [turnId, now()]);
          this.log.info({ chatId, turnId }, "turn cancelled by a newer message; messages carried forward");
        } else {
          await q(`UPDATE turns SET status='done', finished_at=$2 WHERE id=$1`, [turnId, now()]);
        }
      } else {
        this.log.error({ chatId, turnId, err: (err as Error).message }, "turn failed");
        await recordJobFailure("turn", turnId, { chatId }, err, chatId);
        await q(`UPDATE turns SET status='failed', finished_at=$2 WHERE id=$1`, [turnId, now()]);
      }
    } finally {
      this.unpromptedTurns.delete(turnId);
      // Typing still showing with nothing sent after it (a silent, failed or cancelled turn): clear it.
      if (st.typingOn) await this.setTyping(st, chatId, false);
      st.running = undefined;
      resolveDone();
      if (answers) st.nudge = undefined;
      if ((await hasUnclaimed(chatId)) || st.nudge) this.bump(st);
      else this.checkIdle(st);
    }
  }

  /** An unprompted bubble that restates a recent ask or nudge (atlas_log, pg_trgm) isn't sent again. */
  private async dropRestated(chatId: number, turnId: number, actions: Action[]): Promise<Action[]> {
    const kept: Action[] = [];
    for (const action of actions) {
      if (action.type === "say") {
        const prior = await restates(chatId, action.text, now()).catch(() => undefined);
        if (prior) {
          this.log.info({ chatId, turnId, similarity: prior.similarity.toFixed(2) }, "dropped a follow-up that restates a recent message");
          continue;
        }
      }
      kept.push(action);
    }
    return kept;
  }

  // ---------- outbound ----------

  /** Queue actions for a chat. guidPrefix must be unique per producer (turn, job). */
  async enqueue(chatId: number, guidPrefix: string, actions: Action[], turnId: number | null = null): Promise<void> {
    if (actions.length === 0) return;
    const at = now();
    for (const [idx, action] of actions.entries()) {
      await q(
        `INSERT INTO outbox (chat_id, turn_id, idx, client_guid, action, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (client_guid) DO NOTHING`,
        [chatId, turnId, idx, `${guidPrefix}-${idx}`, JSON.stringify(action), at],
      );
    }
  }

  /** Send a chat's pending outbox rows in order. Serialized per chat; safe to call repeatedly. */
  flush(chatId: number, opts: { turnId?: number; signal?: AbortSignal; onFirstSend?: () => void } = {}): Promise<void> {
    const st = this.byChatId.get(chatId) ?? this.state(`chat:${chatId}`);
    this.byChatId.set(chatId, st);
    st.chatId ??= chatId;
    const run = st.flushing.then(() => this.flushNow(chatId, opts));
    st.flushing = run.catch(() => {});
    return run.finally(() => this.checkIdle(st));
  }

  private async flushNow(chatId: number, opts: { turnId?: number; signal?: AbortSignal; onFirstSend?: () => void }): Promise<void> {
    const rows = await q<{ id: number; client_guid: string; action: Action; attempts: number; turn_id: number | null }>(
      `SELECT id, client_guid, action, attempts, turn_id FROM outbox WHERE chat_id = $1 AND status = 'pending' ORDER BY id`,
      [chatId],
    );
    if (rows.length === 0) return;
    const chat = await getChat(chatId);
    if (!chat) return;
    const space = this.spaces.get(chatId) ?? (await this.opts.resolveSpace(chat));
    this.spaces.set(chatId, space);
    const st = this.byChatId.get(chatId);
    let sentAny = false;
    let bubbles = 0;
    const cancelledBeforeSend = (row: { turn_id: number | null }) => opts.signal?.aborted && !sentAny && row.turn_id === opts.turnId;
    for (const row of rows) {
      if (cancelledBeforeSend(row)) throw new Cancelled();
      const typed = typedText(row.action);
      if (typed !== null) {
        let pause = this.opts.pacing?.(typed, bubbles) ?? 0;
        // The indicator has been up while the brain thought: that already counts as typing time.
        if (bubbles === 0 && st?.typingSince !== undefined) pause -= Date.now() - st.typingSince;
        if (pause > 0) {
          const t0 = Date.now();
          if (st) await this.setTyping(st, chatId, true);
          const left = pause - (Date.now() - t0);
          if (left > 0) await sleep(left);
          // A newer message may have cancelled the turn, or the row been skipped, while we paused.
          if (cancelledBeforeSend(row)) throw new Cancelled();
          const still = await one<{ status: string }>(`SELECT status FROM outbox WHERE id = $1`, [row.id]);
          if (still?.status !== "pending") continue;
        }
        bubbles += 1;
      }
      // Never let a late typing "start" land after the bubble it was meant to precede.
      if (st?.typingCall) await settleWithin(st.typingCall, TYPING_TIMEOUT_MS);
      let rendered: Awaited<ReturnType<typeof render>>;
      try {
        rendered = await render(space, row.action, row.client_guid);
      } catch (err) {
        const attempts = row.attempts + 1;
        const failed = attempts >= 5;
        await q(`UPDATE outbox SET attempts = $2, last_error = $3, status = $4 WHERE id = $1`, [row.id, attempts, (err as Error).message, failed ? "failed" : "pending"]);
        await recordJobFailure("outbox", row.id, { chatId, action: row.action }, err, chatId);
        if (!failed) await enqueueJob("outbox.flush", { chatId }, { dueAt: new Date(now().getTime() + 2_000 * 2 ** attempts), singletonKey: `outbox:${chatId}` });
        return; // keep order: later rows wait for this one
      }
      if (!sentAny) {
        sentAny = true;
        opts.onFirstSend?.();
      }
      // The recipient's typing bubble goes away when a message lands.
      if (st && rendered.renderedAs !== "skipped") {
        st.typingOn = false;
        st.typingSince = undefined;
      }
      // The bubble is out. Bookkeeping failures past this point must never re-send it.
      try {
        await q(`UPDATE outbox SET status = $2, rendered_as = $3, provider_message_id = $4, sent_at = $5, attempts = attempts + 1 WHERE id = $1`, [
          row.id,
          rendered.renderedAs === "skipped" ? "skipped" : "sent",
          rendered.renderedAs,
          rendered.providerMessageIds[0] ?? null,
          now(),
        ]);
        if (rendered.renderedAs !== "skipped") await this.logOutbound(chatId, row, rendered);
      } catch (err) {
        this.log.error({ chatId, outboxId: row.id, err: (err as Error).message }, "sent, but logging the outbound message failed");
        await recordJobFailure("outbox.log", row.id, { chatId, action: row.action }, err, chatId);
      }
    }
  }

  /** Show or clear the typing indicator. Never throws, never blocks longer than TYPING_TIMEOUT_MS. */
  private async setTyping(st: ChatState, chatId: number, on: boolean): Promise<void> {
    if (this.opts.typing === false) return;
    if (on === !!st.typingOn) return;
    st.typingOn = on;
    st.typingSince = on ? Date.now() : undefined;
    const call = (async () => {
      const space = this.spaces.get(chatId) ?? (await this.resolveSpaceFor(chatId));
      if (!space) return;
      if (typeof this.opts.typing === "function") await this.opts.typing(space, on);
      else if (on) await space.startTyping();
      else await space.stopTyping();
    })().catch((err) => this.log.debug({ chatId, on, err: (err as Error).message }, "typing indicator failed"));
    st.typingCall = call;
    await settleWithin(call, TYPING_TIMEOUT_MS);
  }

  private async resolveSpaceFor(chatId: number): Promise<Space | undefined> {
    const chat = await getChat(chatId);
    if (!chat) return undefined;
    const space = await this.opts.resolveSpace(chat);
    this.spaces.set(chatId, space);
    return space;
  }

  private async logOutbound(
    chatId: number,
    row: { client_guid: string; action: Action; turn_id: number | null },
    rendered: { renderedAs: string; providerMessageIds: string[]; shownText: string },
  ): Promise<void> {
    const action = row.action;
    const at = now();
    const message = {
      chatId,
      personId: null,
      providerMessageId: rendered.providerMessageIds[0] ?? `out:${row.client_guid}`,
      direction: "outbound" as const,
      kind: action.type === "say" ? "text" : action.type === "react" ? "reaction" : action.type,
      text: rendered.shownText,
      replyToProviderId: action.type === "say" ? (action.replyTo ?? null) : action.type === "react" ? action.targetId : null,
      meta: { providerIds: rendered.providerMessageIds, clientGuid: row.client_guid, renderedAs: rendered.renderedAs, pollId: action.type === "poll" ? (action.pollId ?? null) : null },
      sentAt: at,
      receivedAt: at,
      turnId: row.turn_id,
    };
    try {
      await insertMessage(message);
    } catch (err) {
      // The producing turn row is gone (a demo reset or manual cleanup while the row waited to be
      // sent): keep the history line, just without the turn link.
      if ((err as { code?: string }).code !== "23503" || row.turn_id === null) throw err;
      this.log.warn({ chatId, turnId: row.turn_id }, "outbound message's turn no longer exists; logging it without one");
      await insertMessage({ ...message, turnId: null });
    }
    if (action.type === "say" || action.type === "poll") {
      await logSent({ chatId, turnId: row.turn_id, text: rendered.shownText, unprompted: row.turn_id !== null && this.unpromptedTurns.has(row.turn_id), actionType: action.type, at }).catch((err) =>
        this.log.warn({ chatId, err: (err as Error).message }, "could not write atlas_log"),
      );
    }
    if (action.type === "poll" && action.pollId) {
      const [first, ...optionIds] = rendered.providerMessageIds;
      await q(`UPDATE polls SET provider_poll_id = $2, rendered_as = $3, option_message_ids = $4 WHERE id = $1`, [
        action.pollId,
        rendered.renderedAs === "native" ? first : null,
        rendered.renderedAs === "native" ? "native" : "text",
        JSON.stringify(rendered.renderedAs === "native" ? [] : optionIds),
      ]);
    }
  }

  // ---------- idle tracking (simulator + tests) ----------

  /** The simulator calls this before pushing an event, so waitIdle can't resolve before ingest. */
  expect(platform: string, providerChatId: string): void {
    this.state(`${platform}:${providerChatId}`).expected += 1;
  }

  waitIdle(platform: string, providerChatId: string): Promise<void> {
    const st = this.state(`${platform}:${providerChatId}`);
    if (this.isIdle(st)) return Promise.resolve();
    return new Promise((resolve) => st.waiters.push(resolve));
  }

  private isIdle(st: ChatState): boolean {
    return st.expected === 0 && !st.timer && !st.running;
  }

  private checkIdle(st: ChatState): void {
    if (!this.isIdle(st)) return;
    // A flush may still be in flight; resolve after it settles.
    void st.flushing.then(() => {
      if (!this.isIdle(st)) return;
      for (const w of st.waiters.splice(0)) w();
    });
  }

  // ---------- recovery ----------

  /** On boot: answer anything left unclaimed and finish any half-sent replies. */
  async recover(): Promise<void> {
    for (const chatId of await chatsWithUnclaimed()) await this.poke(chatId);
    const pending = await q<{ chat_id: number }>(`SELECT DISTINCT chat_id FROM outbox WHERE status = 'pending'`);
    for (const row of pending) void this.flush(row.chat_id).catch(() => {});
  }

  members(chatId: number) {
    return activeMembers(chatId);
  }
}
