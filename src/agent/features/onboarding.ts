// Getting a chat to the point where Atlas can plan, one question at a time, the same way in a
// group chat and a private one. Each person goes name → bank (connect their capital one, or a rough
// budget) on their own; once someone is through, the chat is asked where and when. As soon as one
// answer lands (a name, a connect, a budget), the next question goes out, aimed at whoever still owes
// it, and never more than one question in a message: a reply that already asks something waits.
// Anyone who goes quiet on an open question gets one beckon a few hours later (the bank question's
// beckon is connect.nudge). Everything here is deterministic; the agent is told not to ask these.
import { now } from "../../clock.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, getChat, labelOf, type ChatRow, type MemberRow } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { recordAsk } from "../../profile/store.ts";
import { stagesOf } from "../../trips/stages.ts";
import { tripFor, type TripRow } from "../../trips/state.ts";
import type { Action } from "../../transport/outbound.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { CONNECT_QUESTION, isConnected, offerConnect } from "./connect.ts";
import { NAME_FIELD, NAME_QUESTION, laterNameAsk, recordNameAsks, unnamed } from "./names.ts";
import { nameList } from "./planning.ts";

export const WHERE_FIELD = "where_when";
export const BECKON_JOB = "onboarding.beckon";
/** One beckon per open question, this long after it was asked. */
export const BECKON_AFTER_MS = 3 * 3_600_000;
/** tc.notes key: something this turn answered an onboarding question, so the next one can go out. */
export const PROGRESS = "onboarding.progress";

export type AskKind = "name" | "connect" | "where" | "when";
export interface Ask {
  kind: AskKind;
  people: MemberRow[];
  text: string;
}

const first = (m: MemberRow) => labelOf(m).toLowerCase().split(/\s+/)[0] ?? "";

/** "where are we thinking, and when?" in a group, "where are you thinking of heading, and when?" one-on-one. */
export function whereQuestion(isGroup: boolean, kind: "where" | "when"): string {
  if (kind === "when") return isGroup ? "when are we thinking of going?" : "when are you thinking of going?";
  return isGroup ? "where are we thinking, and when?" : "where are you thinking of heading, and when?";
}

/** Atlas's where/when ask (any phrasing above). */
export function isWhereAsk(text: string): boolean {
  return /\b(?:where are (?:we|you) thinking|when are (?:we|you) thinking of going)\b/.test(text);
}

interface PersonState {
  member: MemberRow;
  named: boolean;
  nameAsked: boolean;
  /** Connected anywhere, or gave this trip a rough budget. */
  bankDone: boolean;
  /** Atlas has asked them about their bank in this chat. */
  bankAsked: boolean;
}

async function peopleOf(chatId: number, members: MemberRow[], trip: Pick<TripRow, "id">): Promise<PersonState[]> {
  const ids = members.map((m) => m.id);
  const [asked, rows, stated] = await Promise.all([
    q<{ person_id: number }>(`SELECT person_id FROM asks WHERE chat_id = $1 AND field = $2`, [chatId, NAME_FIELD]),
    q<{ person_id: number }>(`SELECT person_id FROM bank_connections WHERE chat_id = $1`, [chatId]),
    q<{ person_id: number }>(`SELECT person_id FROM budgets WHERE trip_id = $1 AND person_id = ANY($2) AND adjusted_cents IS NOT NULL`, [trip.id, ids]),
  ]);
  const nameAsked = new Set(asked.map((r) => Number(r.person_id)));
  const bankAsked = new Set(rows.map((r) => Number(r.person_id)));
  const budgeted = new Set(stated.map((r) => Number(r.person_id)));
  return Promise.all(
    members.map(async (m) => ({
      member: m,
      named: Boolean(m.display_name),
      nameAsked: nameAsked.has(m.id),
      bankDone: budgeted.has(m.id) || (await isConnected(m.id)),
      bankAsked: bankAsked.has(m.id),
    })),
  );
}

async function whereAsked(chatId: number): Promise<boolean> {
  return Boolean(await one(`SELECT 1 FROM asks WHERE chat_id = $1 AND field = $2 LIMIT 1`, [chatId, WHERE_FIELD]));
}

/**
 * The one question Atlas should ask next in this chat, or null when nothing is left to ask (or
 * everything left is already asked and waiting on an answer). Pure apart from reads.
 */
export async function nextAsk(chat: Pick<ChatRow, "id" | "is_group">, members: MemberRow[], trip: TripRow, opts: { intro?: boolean } = {}): Promise<Ask | null> {
  if (!members.length) return null;
  const people = await peopleOf(chat.id, members, trip);
  // 1. Names, for anyone Atlas only has a number for and hasn't asked.
  const nameless = people.filter((p) => !p.named && !p.nameAsked).map((p) => p.member);
  if (nameless.length) {
    const askedBefore = people.some((p) => p.nameAsked);
    return { kind: "name", people: nameless, text: askedBefore && chat.is_group ? laterNameAsk(nameless.map((m) => labelOf(m))) : NAME_QUESTION };
  }
  // 2. The bank, for anyone named who hasn't been asked and has neither connected nor given a budget.
  const bank = people.filter((p) => p.named && !p.bankDone && !p.bankAsked).map((p) => p.member);
  if (bank.length) {
    const everyone = bank.length === members.length;
    const who = everyone ? "" : `${nameList(bank.map(first))}, `;
    return { kind: "connect", people: bank, text: `${who}${CONNECT_QUESTION}` };
  }
  // 3. Where and when, once someone is through their own questions.
  if (!people.some((p) => p.named && p.bankDone) || (await whereAsked(chat.id))) return null;
  const stages = stagesOf(trip);
  const where = stages.location === "open" && !trip.destination_name;
  const when = stages.dates === "open" && !trip.start_date;
  if (!where && !when) return null;
  const kind = where ? "where" : "when";
  return { kind, people: members, text: `${opts.intro ? "so" : "next up so i can start planning:"} ${whereQuestion(chat.is_group, kind)}` };
}

/** Record that the ask went out (so it's never asked twice) and schedule its beckon. */
export async function recordAsked(chatId: number, ask: Ask, at: Date): Promise<void> {
  const ids = ask.people.map((m) => m.id);
  if (ask.kind === "name") await recordNameAsks(chatId, ids, at);
  else if (ask.kind === "connect") await offerConnect(chatId, ids, at);
  else for (const id of ids) await recordAsk(id, chatId, WHERE_FIELD, at);
  if (ask.kind !== "connect") await enqueueJob(BECKON_JOB, { chatId }, { singletonKey: `${BECKON_JOB}:${chatId}`, dueAt: new Date(at.getTime() + BECKON_AFTER_MS) });
}

/** A message that asks for an answer: ends in a question, or says "reply yes". */
export function asksForAnswer(text: string): boolean {
  return /\?\s*$/.test(text.trim()) || /\b(?:reply|say|type|text)\s+"?(?:yes|no|confirm|ok)\b/i.test(text) || /reply with your first name/.test(text);
}

export const asking = (actions: Action[]) => actions.some((a) => (a.type === "say" && asksForAnswer(a.text)) || a.type === "poll");
const speaking = (actions: Action[]) => actions.some((a) => a.type === "say" || a.type === "link" || a.type === "poll");

/**
 * At the end of a turn: when something this turn answered an onboarding question, or Atlas is
 * speaking anyway, add the next question, unless this turn already asks one (that waits for later).
 */
export async function appendNextAsk(tc: TurnCtx, actions: Action[]): Promise<void> {
  if (!tc.chat.intro_sent_at || tc.chat.quiet_mode || asking(actions)) return;
  if (!tc.notes.get(PROGRESS) && !speaking(actions)) return;
  const ask = await nextAsk(tc.chat, tc.members, await tripFor(tc.chat.id));
  if (!ask) return;
  // Where and when follows an answer; tacked onto some other reply it would talk over the plan.
  if (!tc.notes.get(PROGRESS) && (ask.kind === "where" || ask.kind === "when")) return;
  actions.push({ type: "say", text: ask.text });
  await recordAsked(tc.chat.id, ask, tc.now);
}

/** The question that goes out right after "maya's connected ✓" (null when there's nothing to ask). */
export async function askAfterConnect(chatId: number, at: Date): Promise<string | null> {
  const chat = await getChat(chatId);
  if (!chat) return null;
  const ask = await nextAsk(chat, await activeMembers(chatId), await tripFor(chatId));
  if (!ask) return null;
  await recordAsked(chatId, ask, at);
  return ask.text;
}

export const onboardingFeature: Feature = {
  name: "onboarding",

  async situation(tc) {
    if (!tc.chat.intro_sent_at) return null;
    const people = await peopleOf(tc.chat.id, tc.members, tc.trip);
    if (people.every((p) => p.named && p.bankDone)) return null;
    return {
      title: "getting set up",
      lines: ["the name, capital one and where/when questions go out on their own, one at a time. don't ask them yourself, and don't add a question of your own on top"],
    };
  },

  jobs(svc: AppServices) {
    return {
      // One beckon for a name or where/when question nobody answered; one question per message.
      [BECKON_JOB]: async (payload, { jobId }) => {
        const chatId = Number(payload.chatId);
        const chat = await getChat(chatId);
        if (!chat || chat.quiet_mode) return;
        const at = now();
        const members = await activeMembers(chatId);
        const asks = await q<{ person_id: number; field: string; asked_at: Date }>(
          `SELECT person_id, field, asked_at FROM asks WHERE chat_id = $1 AND field = ANY($2)`,
          [chatId, [NAME_FIELD, WHERE_FIELD, `${NAME_FIELD}:beckon`, `${WHERE_FIELD}:beckon`]],
        );
        const beckoned = new Set(asks.filter((a) => a.field.endsWith(":beckon")).map((a) => `${a.person_id}:${a.field.replace(":beckon", "")}`));
        const due = (a: { asked_at: Date }) => a.asked_at.getTime() + BECKON_AFTER_MS - 60_000 <= at.getTime();
        const byId = new Map(members.map((m) => [m.id, m]));
        const pending = { next: Infinity };
        const later = (a: { asked_at: Date }) => (pending.next = Math.min(pending.next, a.asked_at.getTime() + BECKON_AFTER_MS));
        const again = () => (Number.isFinite(pending.next) ? { rescheduleAt: new Date(pending.next) } : undefined);

        // Names first: whoever is still only a number.
        const nameAsks = asks.filter((a) => a.field === NAME_FIELD && !beckoned.has(`${a.person_id}:${NAME_FIELD}`) && byId.has(a.person_id) && !byId.get(a.person_id)!.display_name);
        const nameDue = nameAsks.filter(due);
        nameAsks.filter((a) => !due(a)).forEach(later);
        if (nameDue.length) {
          const people = nameDue.map((a) => byId.get(a.person_id)!);
          for (const m of people) await recordAsk(m.id, chatId, `${NAME_FIELD}:beckon`, at);
          const text = chat.is_group
            ? `${nameList(people.map((m) => labelOf(m)))}, still need your first name so i know who's who 🙋 just reply with it`
            : `still need your first name so i know who's who 🙋 just reply with it`;
          await svc.post(chatId, `beckon${jobId}`, [{ type: "say", text }]);
          return again();
        }

        // Where and when: only if nobody has said anything since it was asked.
        const where = asks.filter((a) => a.field === WHERE_FIELD);
        if (where.length && !where.some((a) => beckoned.has(`${a.person_id}:${WHERE_FIELD}`))) {
          const askedAt = new Date(Math.min(...where.map((a) => a.asked_at.getTime())));
          if (!due({ asked_at: askedAt })) return { rescheduleAt: new Date(askedAt.getTime() + BECKON_AFTER_MS) };
          const since = await one(`SELECT 1 FROM messages WHERE chat_id = $1 AND direction = 'inbound' AND sent_at > $2 LIMIT 1`, [chatId, askedAt]);
          if (!since) {
            const trip = await tripFor(chatId);
            const stages = stagesOf(trip);
            const kind = stages.location === "open" && !trip.destination_name ? "where" : stages.dates === "open" && !trip.start_date ? "when" : null;
            if (kind) {
              for (const a of where) await recordAsk(a.person_id, chatId, `${WHERE_FIELD}:beckon`, at);
              const text = chat.is_group
                ? `still keen on this trip? i can start pulling options as soon as i know ${kind === "where" ? "where and when" : "when"} 👀\n${whereQuestion(true, kind)}`
                : `still up for a trip? i can start pulling options as soon as i know ${kind === "where" ? "where and when" : "when"} 👀\n${whereQuestion(false, kind)}`;
              await svc.post(chatId, `beckon${jobId}`, [{ type: "say", text }]);
            }
          }
        }
        return again();
      },
    };
  },
};
