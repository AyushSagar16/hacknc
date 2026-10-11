// Who's who. A real line gives Atlas phone numbers, not contact names, so unless demo/roster.json
// names someone, Atlas can only call them "…8005". The intro (and a late joiner's welcome) asks
// everyone it has no name for to reply with their first name; in a chat that's already going, the
// first turn that sees someone unnamed and never asked queues the question once (asks field
// "name"). Answers are read without a model:
//   - from someone unnamed, while their ask is open: "ayush", "i'm ayush", "it's ayush", "ayush here"
//   - any time: "my name is ayush", "call me ayush"
//   - anyone naming anyone by the last four digits Atlas shows: "8005 is maya", "maya is …8005"
// Extraction still catches names said in passing ("it's priya btw").
import { now } from "../../clock.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, labelOf, setDisplayName, type MemberRow, type MessageRow } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { recordAsk } from "../../profile/store.ts";
import { destinations } from "../../trips/catalog.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { say } from "../tools.ts";
import { nameList } from "./planning.ts";

export const NAME_FIELD = "name";
export const NAMES_ASK_JOB = "names.ask";
/** How long after the ask a bare name ("ayush") is read as the sender's name. */
export const NAME_ASK_OPEN_MS = 6 * 3_600_000;

/** In the intro, before anyone has a name. */
export const NAME_QUESTION = "quick one so i know who's who: i only see phone numbers here, so reply with your first name 🙋";

/** For a chat that's already going: "btw i only see numbers for …8005 and …9866. ..." */
export function laterNameAsk(labels: string[]): string {
  return `btw so i know who's who: i only see numbers for ${nameList(labels)}. reply with your first name 🙋 (or anyone can tell me, like "${labels[0]?.replace("…", "") ?? "8005"} is maya")`;
}

/** Atlas's own lines about names, which don't close the bank-connect question. */
export function isNameLine(text: string): boolean {
  return /who's who|^got it: …\d{4} is|i know everyone now/.test(text);
}

const last4 = (handle: string | null) => (handle ?? "").replace(/\D/g, "").slice(-4);
const cap = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

// Words that can follow "i'm"/"it's" or stand alone after the ask and aren't names.
const NOT_NAMES = new Set(
  (
    "yes yeah yea yep yup ya ye no nope nah ok okay k kk sure alright lol lmao haha hahaha hi hey hello yo sup hiya howdy " +
    "thanks thx ty down in out up good fine great cool nice bet word same idk maybe here there atlas me you him her them us " +
    "everyone everybody free busy excited tired sorry not just also too the a an and or but connect skip done ready back late " +
    "on off going driving flying coming leaving gonna broke hungry sick confused lost new sounds what who why how when where " +
    "which this that it its is are was were be been do does did can could would should will " +
    "budget price cost total trip flight hotel rent number year"
  ).split(/\s+/),
);

let placeWords: Set<string> | undefined;
/** Bare destination names ("asheville") aren't names. */
function isPlace(word: string): boolean {
  placeWords ??= new Set(destinations().flatMap((d) => [d.name.toLowerCase(), ...d.name.toLowerCase().split(/[\s,]+/)]));
  return placeWords.has(word);
}

function nameWord(w: string | undefined): string | null {
  if (!w) return null;
  const word = w.toLowerCase();
  if (!/^[a-z][a-z'-]{1,19}$/.test(word) || NOT_NAMES.has(word) || isPlace(word)) return null;
  return word;
}

const WORD = String.raw`([a-z][a-z'-]{1,19})`;
const TRAIL = String.raw`[\s.!👋🙋]*`;
const GREETING = String.raw`(?:(?:hi|hey|yo|hello|sup)[\s,!]+)?`;
const EXPLICIT = new RegExp(String.raw`^${GREETING}(?:my name(?:'s| is)|call me)\s+${WORD}(?:\s+${WORD})?${TRAIL}$`, "i");
const ANSWER = new RegExp(String.raw`^${GREETING}(?:(?:i'?m|i am|it'?s|its|this is)\s+)?${WORD}(?:\s+(?!here\b)${WORD})?(?:\s+here)?${TRAIL}$`, "i");

/** The sender's own name, or null. `askOpen`: Atlas just asked them, so a bare "ayush" counts. */
export function parseOwnName(text: string, askOpen: boolean): string | null {
  const s = text.trim().replace(/[’‘]/g, "'");
  if (!s || s.length > 40) return null;
  const m = EXPLICIT.exec(s) ?? (askOpen ? ANSWER.exec(s) : null);
  if (!m) return null;
  const firstWord = nameWord(m[1]);
  if (!firstWord) return null;
  const second = m[2] ? nameWord(m[2]) : null;
  if (m[2] && !second) return null; // "i'm down", "sounds good"
  return second ? `${cap(firstWord)} ${cap(second)}` : cap(firstWord);
}

const DIGITS_FIRST = new RegExp(String.raw`(?:^|[\s,;&(])(?:…|\.{2,3}|\+?\d{0,11})?(\d{4})\s*(?:is|=|:|-|'s)\s*${WORD}`, "gi");
const NAME_FIRST = new RegExp(String.raw`(?:^|[\s,;&(])${WORD}\s+(?:is|=)\s*(?:…|\.{2,3})?(\d{4})\b`, "gi");

/** "8005 is maya, …9866 is leo" → [{digits: "8005", name: "Maya"}, ...] for members with those digits. */
export function parseNamedNumbers(text: string, members: Pick<MemberRow, "id" | "handle">[]): { personId: number; digits: string; name: string; span: string }[] {
  const s = text.replace(/[’‘]/g, "'");
  const out: { personId: number; digits: string; name: string; span: string }[] = [];
  const add = (digits: string, raw: string, span: string) => {
    const name = nameWord(raw);
    const hits = members.filter((m) => last4(m.handle) === digits);
    if (!name || hits.length !== 1 || out.some((o) => o.personId === hits[0]!.id)) return;
    out.push({ personId: hits[0]!.id, digits, name: cap(name), span });
  };
  for (const m of s.matchAll(DIGITS_FIRST)) add(m[1]!, m[2]!, m[0]);
  for (const m of s.matchAll(NAME_FIRST)) add(m[2]!, m[1]!, m[0]);
  return out;
}

export function unnamed<T extends Pick<MemberRow, "display_name">>(members: T[]): T[] {
  return members.filter((m) => !m.display_name);
}

/** Record that these people were asked their name (once per person and chat). */
export async function recordNameAsks(chatId: number, personIds: number[], at: Date): Promise<void> {
  for (const id of personIds) await recordAsk(id, chatId, NAME_FIELD, at);
}

async function askedAt(personId: number, chatId: number): Promise<Date | null> {
  return (await one<{ asked_at: Date }>(`SELECT asked_at FROM asks WHERE person_id = $1 AND chat_id = $2 AND field = $3`, [personId, chatId, NAME_FIELD]))?.asked_at ?? null;
}

/** Save a name and update this turn's member rows, so the rest of the turn uses it. */
async function learn(tc: TurnCtx, personId: number, name: string): Promise<void> {
  await setDisplayName(personId, name, { overwrite: true });
  const m = tc.members.find((x) => x.id === personId);
  if (m) m.display_name = name;
}

export const namesFeature: Feature = {
  name: "names",

  async fastPath(msg: MessageRow, tc: TurnCtx) {
    if (msg.kind !== "text" || msg.person_id === null || !msg.speakable) return false;
    // Someone naming a number (any member, any time).
    const named = parseNamedNumbers(msg.text, tc.members);
    if (named.length) {
      for (const n of named) await learn(tc, n.personId, n.name);
      say(tc, `got it: ${named.map((n) => `…${n.digits} is ${n.name.toLowerCase()}`).join(", ")} 👍`);
      let rest = msg.text;
      for (const n of named) rest = rest.replace(n.span, " ");
      // Only names in it: handled. Anything else goes on to the rest of the turn.
      return !/[a-z0-9]/i.test(rest.replace(/\b(?:and|also|btw|oh|ok|okay)\b/gi, ""));
    }
    // The sender's own name.
    const me = tc.members.find((m) => m.id === msg.person_id);
    if (!me) return false;
    const asked = me.display_name ? null : await askedAt(me.id, tc.chat.id);
    const askOpen = asked !== null && msg.sent_at.getTime() - asked.getTime() <= NAME_ASK_OPEN_MS;
    const name = parseOwnName(msg.text, askOpen);
    if (!name) return false;
    await learn(tc, me.id, name);
    if (msg.provider_message_id) tc.out.push({ type: "react", targetId: msg.provider_message_id, tapback: "like", fallbackText: `got it, ${name.toLowerCase().split(" ")[0]} 👍` });
    // The last one Atlas was waiting on: say so once.
    if (askOpen && unnamed(tc.members).length === 0 && tc.members.length > 1) {
      say(tc, `i know everyone now 👋 ${nameList(tc.members.map((m) => labelOf(m).toLowerCase().split(/\s+/)[0]!))}`);
    }
    return true;
  },

  async situation(tc) {
    const missing = unnamed(tc.members);
    if (!missing.length) return null;
    return {
      title: "names",
      lines: [
        `you only have phone numbers for ${nameList(missing.map((m) => labelOf(m)))}. the name question goes out on its own; don't guess names. when you need them, call them by those numbers`,
      ],
    };
  },

  async afterTurn(tc) {
    // A chat that was already going (or members Atlas learned after the intro): ask once.
    if (!tc.chat.is_group || tc.chat.quiet_mode || !tc.chat.intro_sent_at) return;
    const missing = unnamed(tc.members);
    if (!missing.length) return;
    const asked = await q<{ person_id: number }>(`SELECT person_id FROM asks WHERE chat_id = $1 AND field = $2`, [tc.chat.id, NAME_FIELD]);
    const done = new Set(asked.map((r) => Number(r.person_id)));
    if (missing.every((m) => done.has(m.id))) return;
    await enqueueJob(NAMES_ASK_JOB, { chatId: tc.chat.id }, { dueAt: new Date(now().getTime() + 4_000), singletonKey: `names:ask:${tc.chat.id}` });
  },

  jobs(svc: AppServices) {
    return {
      [NAMES_ASK_JOB]: async (payload, { jobId }) => {
        const chatId = Number(payload.chatId);
        const chat = await one<{ quiet_mode: boolean }>(`SELECT quiet_mode FROM chats WHERE id = $1`, [chatId]);
        if (!chat || chat.quiet_mode) return;
        const asked = new Set((await q<{ person_id: number }>(`SELECT person_id FROM asks WHERE chat_id = $1 AND field = $2`, [chatId, NAME_FIELD])).map((r) => Number(r.person_id)));
        const todo = unnamed(await activeMembers(chatId)).filter((m) => !asked.has(m.id));
        if (!todo.length) return;
        await recordNameAsks(chatId, todo.map((m) => m.id), now());
        await svc.post(chatId, `names${jobId}`, [{ type: "say", text: laterNameAsk(todo.map((m) => labelOf(m))) }]);
      },
    };
  },
};
