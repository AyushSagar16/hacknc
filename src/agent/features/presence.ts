// Atlas keeps the plan moving when the group goes quiet. After a human message Atlas didn't answer,
// a follow-up is scheduled (and pushed back by every new message); when it fires with the chat
// still quiet, Atlas looks at where the plan stands and takes the next step, or stays out of it.
// The same check runs when Atlas comes online, for groups that were mid-conversation.
import type { Config } from "../../config.ts";
import { now } from "../../clock.ts";
import { one, q } from "../../db/pool.ts";
import { getChat, type MessageRow } from "../../db/repos/core.ts";
import { enqueueJob, rescheduleSingleton } from "../../pipeline/jobs.ts";
import type { AppServices, Feature } from "../feature.ts";

export const NUDGE_JOB = "chat.nudge";
/** Don't follow up on a conversation that died this long ago. */
const STALE_MS = 12 * 3_600_000;

export function nudgeIdleSeconds(cfg: Config): number {
  return cfg.NUDGE_IDLE_SECONDS ?? (cfg.IMESSAGE_MODE === "sim" ? 0 : 150);
}

const key = (chatId: number) => `nudge:${chatId}`;

/** Schedule (or push back) this chat's follow-up. */
export async function scheduleNudge(chatId: number, dueAt: Date, why: "idle" | "online"): Promise<void> {
  const id = await enqueueJob(NUDGE_JOB, { chatId, why }, { singletonKey: key(chatId), dueAt, maxAttempts: 2 });
  if (id === undefined) await rescheduleSingleton(key(chatId), dueAt);
}

/** Groups where people were talking recently and Atlas never answered the last message. */
export async function scheduleOnlineNudges(cfg: Config): Promise<number> {
  if (nudgeIdleSeconds(cfg) === 0) return 0;
  const rows = await q<{ chat_id: number }>(
    `SELECT c.id AS chat_id
       FROM chats c
       JOIN LATERAL (SELECT direction, sent_at FROM messages m WHERE m.chat_id = c.id AND m.kind = 'text' ORDER BY sent_at DESC, id DESC LIMIT 1) last ON true
      WHERE c.is_group AND NOT c.quiet_mode AND c.intro_sent_at IS NOT NULL
        AND last.direction = 'inbound' AND last.sent_at > $1`,
    [new Date(now().getTime() - STALE_MS)],
  );
  // A few seconds' grace so the model warm-up and any replayed webhooks land first.
  for (const r of rows) await scheduleNudge(r.chat_id, new Date(now().getTime() + 15_000), "online");
  return rows.length;
}

function reason(why: string, last: MessageRow, label: string, at: Date): string {
  const mins = Math.max(1, Math.round((at.getTime() - last.sent_at.getTime()) / 60_000));
  const opener = why === "online"
    ? `you just came back online; the last message, ${mins} min ago from ${label}, never got a reply from you.`
    : `the chat went quiet ${mins} min ago after ${label}'s message, and you haven't replied since.`;
  return `${opener} follow up now and move the plan one step forward: answer anything left hanging, say who's still missing what by name (don't re-ask someone you already asked), or call the tool for the next step (budgets once dates are in, options once a majority has dates and home cities, a reminder on an open poll, settle up after the trip). one or two short lines. NO_REPLY only if the last messages were pure banter with nothing about the trip or money.`;
}

export const presenceFeature: Feature = {
  name: "presence",

  async afterTurn(tc) {
    const seconds = nudgeIdleSeconds(tc.cfg);
    if (seconds === 0 || !tc.chat.is_group || tc.chat.quiet_mode) return;
    // Stale replays (extraction only) don't count: they'd push the come-back-online follow-up out to the idle delay.
    if (!tc.batch.some((m) => m.direction === "inbound" && m.person_id !== null && m.kind === "text" && m.speakable)) return;
    await scheduleNudge(tc.chat.id, new Date(now().getTime() + seconds * 1000), "idle");
  },

  jobs(svc: AppServices) {
    return {
      [NUDGE_JOB]: async (payload) => {
        const chatId = Number(payload.chatId);
        const chat = await getChat(chatId);
        if (!chat || !chat.is_group || chat.quiet_mode) return;
        const last = await one<MessageRow>(`SELECT * FROM messages WHERE chat_id = $1 AND kind = 'text' ORDER BY sent_at DESC, id DESC LIMIT 1`, [chatId]);
        // Atlas had the last word, or the conversation is long over: nothing to follow up on.
        if (!last || last.direction !== "inbound" || last.person_id === null) return;
        const at = now();
        if (at.getTime() - last.sent_at.getTime() > STALE_MS) return;
        // One follow-up per unanswered message.
        const already = await one(`SELECT 1 FROM turns WHERE chat_id = $1 AND route LIKE 'nudge%' AND started_at > $2 LIMIT 1`, [chatId, last.sent_at]);
        if (already) return;
        const person = await one<{ display_name: string | null; handle: string }>(`SELECT display_name, handle FROM people WHERE id = $1`, [last.person_id]);
        const label = person?.display_name?.split(/\s+/)[0] ?? "someone";
        await svc.nudge(chatId, reason(String(payload.why ?? "idle"), last, label, at));
      },
    };
  },
};
