// The message pipeline. Inbound messages are stored first (deduped per chat), then each chat
// runs its own debounced turn: drain the unclaimed messages, think, enqueue outgoing actions,
// flush them in order with stable client GUIDs. A message that arrives mid-turn cancels the
// turn (unless a money tool already ran or a bubble already went out) and its messages are
// released back to the queue — carry-forward without a second table.
import type { Message, Space } from "spectrum-ts";
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
  /** Milliseconds to pause before a bubble (a person types; 0 in tests). */
  pacing?: (text: string, index: number) => number;
  /** Seconds after which a delivered message is too old to answer (still extracted). */
  staleAfterSeconds?: number;
  /** Known display names by handle (demo roster, simulator). */
  names?: (handle: string) => string | undefined;
  onNewMember?: (chatId: number, personId: number) => void | Promise<void>;
}

class Cancelled extends Error {}

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
}

export class Pipeline {
  private readonly states = new Map<string, ChatState>();
  private readonly byChatId = new Map<number, ChatState>();
  private readonly spaces = new Map<number, Space>();
  private readonly log = childLog({ component: "pipeline" });
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly staleAfterMs: number;

  constructor(private readonly opts: PipelineOptions) {
    this.debounceMs = opts.debounceMs ?? 2_500;
    this.maxWaitMs = opts.maxWaitMs ?? 8_000;
    this.staleAfterMs = (opts.staleAfterSeconds ?? 300) * 1_000;
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
      if (stored && st) this.bump(st);
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

  private bump(st: ChatState): void {
    if (st.running) {
      if (st.running.cancellable) st.running.abort.abort();
      return; // the running turn reschedules when it ends
    }
    if (st.timer) clearTimeout(st.timer);
    const t = Date.now();
    st.firstPendingAt ??= t;
    const delay = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - (t - st.firstPendingAt)));
    st.timer = setTimeout(() => void this.runTurn(st), delay);
  }

  /** Run a turn with no new messages so Atlas can follow up on its own (an idle group, a restart). */
  async nudge(chatId: number, reason: string): Promise<void> {
    const chat = await getChat(chatId);
    if (!chat) return;
    const st = this.state(`${chat.platform}:${chat.provider_chat_id}`);
    st.chatId = chat.id;
    this.byChatId.set(chat.id, st);
    // A turn already running is talking to the group; never cancel it for a follow-up.
    if (st.running || st.timer) return;
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
    try {
      const batch = await claimUnclaimed(chatId, turnId);
      // New messages win over a follow-up: the turn answers them instead.
      const nudge = batch.length === 0 ? st.nudge : undefined;
      st.nudge = undefined;
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
        nonCancellable: async () => {
          if (st.running) st.running.cancellable = false;
          await q(`UPDATE turns SET cancellable = false WHERE id = $1`, [turnId]);
        },
      });
      if (abort.signal.aborted && st.running?.cancellable) throw new Cancelled();
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
      st.running = undefined;
      resolveDone();
      if (await hasUnclaimed(chatId)) this.bump(st);
      else this.checkIdle(st);
    }
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
    let sentAny = false;
    for (const [i, row] of rows.entries()) {
      if (opts.signal?.aborted && !sentAny && row.turn_id === opts.turnId) throw new Cancelled();
      const pause = this.opts.pacing?.(row.action.type === "say" ? row.action.text : "", i) ?? 0;
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      try {
        const rendered = await render(space, row.action, row.client_guid);
        if (!sentAny) {
          sentAny = true;
          opts.onFirstSend?.();
        }
        await q(`UPDATE outbox SET status = $2, rendered_as = $3, provider_message_id = $4, sent_at = $5, attempts = attempts + 1 WHERE id = $1`, [
          row.id,
          rendered.renderedAs === "skipped" ? "skipped" : "sent",
          rendered.renderedAs,
          rendered.providerMessageIds[0] ?? null,
          now(),
        ]);
        if (rendered.renderedAs !== "skipped") await this.logOutbound(chatId, row, rendered);
      } catch (err) {
        const attempts = row.attempts + 1;
        const failed = attempts >= 5;
        await q(`UPDATE outbox SET attempts = $2, last_error = $3, status = $4 WHERE id = $1`, [row.id, attempts, (err as Error).message, failed ? "failed" : "pending"]);
        await recordJobFailure("outbox", row.id, { chatId, action: row.action }, err, chatId);
        if (!failed) await enqueueJob("outbox.flush", { chatId }, { dueAt: new Date(now().getTime() + 2_000 * 2 ** attempts), singletonKey: `outbox:${chatId}` });
        return; // keep order: later rows wait for this one
      }
    }
  }

  private async logOutbound(
    chatId: number,
    row: { client_guid: string; action: Action; turn_id: number | null },
    rendered: { renderedAs: string; providerMessageIds: string[]; shownText: string },
  ): Promise<void> {
    const action = row.action;
    const at = now();
    await insertMessage({
      chatId,
      personId: null,
      providerMessageId: rendered.providerMessageIds[0] ?? `out:${row.client_guid}`,
      direction: "outbound",
      kind: action.type === "say" ? "text" : action.type === "react" ? "reaction" : action.type,
      text: rendered.shownText,
      replyToProviderId: action.type === "say" ? (action.replyTo ?? null) : action.type === "react" ? action.targetId : null,
      meta: { providerIds: rendered.providerMessageIds, clientGuid: row.client_guid, renderedAs: rendered.renderedAs, pollId: action.type === "poll" ? (action.pollId ?? null) : null },
      sentAt: at,
      receivedAt: at,
      turnId: row.turn_id,
    });
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
