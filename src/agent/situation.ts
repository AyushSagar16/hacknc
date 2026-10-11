// The agent's whole world for one turn, as plain text: who's here, where the trip stands,
// each person's resolved preferences (with their own words), what features contribute
// (budgets, polls, expenses, forecast, recalled memories), the figures it may quote, the
// recent chat and the new messages. Stateless: rebuilt from the database every turn.
import { q } from "../db/pool.ts";
import type { MessageRow } from "../db/repos/core.ts";
import type { Tension } from "../profile/extract.ts";
import type { PersonProfile } from "../profile/aggregate.ts";
import { askedFields } from "../profile/store.ts";
import type { AddressedReason } from "./addressed.ts";
import type { Feature, TurnCtx } from "./feature.ts";

const HISTORY_LINES = 30;

export async function describeSituation(
  tc: TurnCtx,
  opts: {
    remaining: MessageRow[];
    reasons: Map<number, AddressedReason>;
    hints: string[];
    tensions: Tension[];
    features: Feature[];
    agentName: string;
    /** Why the speak gate (or a deterministic trigger) decided Atlas should chime in untagged. */
    speakingBecause?: string;
  },
): Promise<string> {
  const { trip } = tc;
  const [view, profiles, asked, sections] = await Promise.all([
    tc.view(),
    tc.profiles(),
    askedFields(tc.chat.id),
    // Feature sections are independent reads (memory recall's embedding is the slow one): run them together.
    Promise.all(opts.features.map((f) => (f.situation ? f.situation(tc) : null))),
  ]);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tc.chat.timezone }).format(tc.now);

  const lines: string[] = [];
  lines.push(`today is ${weekday} (${tc.chat.timezone}). today's date: ${tc.today}.`);
  lines.push(`group chat with ${tc.members.map((m) => tc.label(m.id)).join(", ")} (${tc.members.length} people).${tc.chat.quiet_mode ? " quiet mode is ON: only reply when tagged." : ""}`);
  lines.push("");
  lines.push("# trip");
  if (trip.title) lines.push(`name: ${trip.title}`);
  lines.push(`status: ${trip.status}`);
  lines.push(`destination: ${trip.destination_name ?? "not chosen"}`);
  lines.push(`dates: ${trip.start_date && trip.end_date ? `${trip.start_date} to ${trip.end_date}` : "not set"}`);
  if (trip.itinerary.length) {
    lines.push("itinerary:");
    for (const d of trip.itinerary) lines.push(`  ${d.date}: ${d.items.map((i) => `${i.name} (${i.setting})`).join(", ")}`);
  }

  lines.push("");
  lines.push("# what each person has said (resolved; newest/explicit wins)");
  for (const m of tc.members) {
    const p = profiles.get(m.id);
    lines.push(`- ${tc.label(m.id)}: ${p ? describeProfile(p) : "nothing yet"}`);
  }
  // Per person, what's known and what isn't, so the agent never claims an unknown.
  const askedAt = await askTimes(tc.chat.id);
  const ago = (d: Date | undefined) => (d ? ` (asked ${humanAgo(tc.now.getTime() - d.getTime())} ago)` : "");
  lines.push("", "# known / unknown (never state a person's dates or home city unless it's ✓ here)");
  for (const m of tc.members) {
    const p = profiles.get(m.id);
    const dates = p?.earliest || p?.latest ? `✓ ${p.earliest?.value ?? "?"} to ${p.latest?.value ?? "?"}` : `UNKNOWN${ago(askedAt.get(`${m.id}:dates`))}`;
    const noFly = p?.travelLimits.some((l) => l.value.kind === "no_flying");
    const city = p?.homeCity ? `✓ ${p.homeCity.value}` : `UNKNOWN${noFly ? " (drives)" : ""}${ago(askedAt.get(`${m.id}:home_city`))}`;
    lines.push(`- ${tc.label(m.id)}: dates ${dates}; home city ${city}`);
  }
  const w = view.window;
  lines.push(
    `group date window: ${w.earliest || w.latest ? `${w.earliest ?? "?"} to ${w.latest ?? "?"}${w.conflict ? " (CONFLICT: windows don't overlap)" : ""} from ${w.knownFrom} of ${tc.members.length}` : "unknown"}${view.dates ? `; first workable dates ${view.dates.start} to ${view.dates.end} (${view.dates.nights} nights)` : ""}`,
  );
  if (w.earliest && w.latest && !w.conflict && w.knownFrom >= 2 && !(trip.start_date && trip.end_date)) {
    const wider = view.members
      .filter((m) => (m.profile.earliest && m.profile.earliest.value < w.earliest!) || (m.profile.latest && m.profile.latest.value > w.latest!))
      .map((m) => `${m.label} said ${m.profile.earliest?.value ?? "?"} to ${m.profile.latest?.value ?? "?"}`);
    if (wider.length) lines.push(`the overlap (${w.earliest} to ${w.latest}) is narrower than what ${wider.join("; ")}. if you haven't said so yet, say the overlap in one line ("overlap is mar 9–14, that work?").`);
  }
  if (view.dates && w.earliest && w.latest && (view.dates.start !== w.earliest || view.dates.end !== w.latest)) {
    lines.push(`note: the first workable dates are shorter than the window (trips default to at most a week); if you propose them, say so.`);
  }
  lines.push(`a majority has shared dates and home cities: ${view.majorityHasShared ? "yes" : "no (hold off on budgets and options unless someone asks)"}`);
  if (view.missing.length) {
    lines.push(
      `still missing: ${view.missing
        .map((m) => `${m.label} (${m.fields.map((f) => (asked.has(`${m.personId}:${f}`) ? `${f}, already asked` : f)).join(", ")})`)
        .join("; ")}${view.majorityHasShared ? " — a majority has shared, don't wait on the rest" : ""}`,
    );
  }
  const vague = await vaguePeriods(tc, profiles);
  if (vague.length) {
    const canSearch = tc.features.some((f) => f.tools?.some((t) => t.decl.name === "web_search"));
    lines.push(
      `dates given as a named period, not exact days: ${vague.map((v) => `${v.label} ("${v.quote}")`).join("; ")}. ${
        canSearch ? "look the period up with web_search (e.g. \"unc chapel hill winter break 2026 dates\")" : "ask for the exact days, or use dates you know for sure"
      }, then once most people's windows are known, call set_trip_dates with dates inside the overlap. never guess the dates.`,
    );
  }
  if (opts.tensions.length) lines.push(`tensions: ${opts.tensions.map((t) => `${t.topic} (${t.sides.map((s) => tc.label(s)).join(" vs ")})`).join("; ")}`);

  for (const section of sections) {
    if (section && section.lines.length) {
      lines.push("", `# ${section.title}`, ...section.lines);
    }
  }

  const allowed = tc.figures.describe({ isGroup: true });
  lines.push("", "# dollar figures you may quote (nothing else)");
  lines.push(...(allowed.length ? allowed.map((a) => `- ${a}`) : ["- none yet: call a tool if you need a number"]));

  if (opts.hints.length) lines.push("", "# heads up", ...opts.hints.map((h) => `- ${h}`));

  const remainingIds = new Set(opts.remaining.map((m) => m.id));
  lines.push("", "# recent chat, oldest first");
  for (const h of tc.history.filter((h) => !remainingIds.has(h.id)).slice(-HISTORY_LINES)) lines.push(line(h, tc));

  lines.push("", "# new messages");
  const TAGS: Record<string, string> = {
    named: " (tags or replies to you)",
    reply_to_atlas: " (tags or replies to you)",
    answers_question: " (may be answering your last question; reply NO_REPLY if it's just banter)",
  };
  for (const m of opts.remaining) lines.push(`${line(m, tc)}${TAGS[opts.reasons.get(m.id) ?? ""] ?? ""}`);
  if (opts.remaining.length === 0) lines.push("(none: you're following up on your own, see heads up)");
  const reasons = [...opts.reasons.values()];
  if (reasons.some((r) => r === "named" || r === "reply_to_atlas")) {
    lines.push("", "note: you were tagged by name, so answer them. NO_REPLY isn't an option here: say what you know, or the one thing you need and from whom.");
  } else if (opts.remaining.length && !reasons.some((r) => r !== null)) {
    // The gate already decided to speak; tell the agent why instead of asking it to second-guess.
    lines.push(
      "",
      `note: nobody tagged you, but you're chiming in because: ${opts.speakingBecause?.trim() || "the plan can move forward here"}. do that in one or two short lines. only reply NO_REPLY if the new messages turn out to be pure banter between friends.`,
    );
  }
  return lines.join("\n");
}

async function askTimes(chatId: number): Promise<Map<string, Date>> {
  const rows = await q<{ person_id: number; field: string; asked_at: Date }>(`SELECT person_id, field, asked_at FROM asks WHERE chat_id = $1`, [chatId]).catch(() => []);
  return new Map(rows.map((r) => [`${r.person_id}:${r.field}`, r.asked_at]));
}

function humanAgo(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function line(m: MessageRow, tc: TurnCtx): string {
  const who = m.direction === "outbound" ? "atlas" : tc.label(m.person_id);
  const reply = m.reply_to_provider_id ? " (threaded reply)" : "";
  return `[${who}]${reply} ${m.text}`;
}

function describeProfile(p: PersonProfile): string {
  const parts: string[] = [];
  if (p.homeCity) parts.push(`from ${p.homeCity.value}`);
  if (p.earliest || p.latest) parts.push(`can travel ${p.earliest ? `from ${p.earliest.value}` : ""}${p.earliest && p.latest ? " " : ""}${p.latest ? `until ${p.latest.value}` : ""}${quote(p.latest ?? p.earliest)}`);
  for (const b of p.blackouts) parts.push(`busy ${b.value.start}–${b.value.end}${quote(b)}`);
  if (p.minNights || p.maxNights) parts.push(`trip length ${p.minNights?.value ?? "?"}–${p.maxNights?.value ?? "?"} nights`);
  if (p.dietary.length) parts.push(p.dietary.map((d) => d.value).join(", "));
  if (p.wants.length) parts.push(`wants ${p.wants.map((x) => `${x.value}${quote(x)}`).join(", ")}`);
  if (p.vetoes.length) parts.push(`vetoes ${p.vetoes.map((x) => `${x.value}${quote(x)}`).join(", ")}`);
  if (p.likes.length) parts.push(`likes ${p.likes.map((x) => x.value).join(", ")}`);
  if (p.dislikes.length) parts.push(`not into ${p.dislikes.map((x) => x.value).join(", ")}`);
  for (const l of p.travelLimits) parts.push(`${l.value.kind.replace(/_/g, " ")}${l.value.hours ? ` (${l.value.hours}h)` : ""}${quote(l)}`);
  if (p.tooExpensive.length) parts.push(`said ${p.tooExpensive.map((t) => t.value).join(", ")} is too pricey`);
  if (p.budgetMood) parts.push(`money is ${p.budgetMood.value}`);
  return parts.length ? parts.join("; ") : "nothing yet";
}

const quote = (r: { quote: string | null } | undefined) => (r?.quote ? ` ("${r.quote}")` : "");

/**
 * People whose latest date window has no dates at all, only a quote like "free during nc state's
 * winter break": the extractor can't turn a named period into days, so the agent should look it up.
 */
async function vaguePeriods(tc: TurnCtx, profiles: Map<number, PersonProfile>): Promise<{ label: string; quote: string }[]> {
  const ids = tc.members.map((m) => m.id).filter((id) => {
    const p = profiles.get(id);
    return !(p?.earliest && p?.latest);
  });
  if (ids.length === 0) return [];
  const rows = await q<{ person_id: number; quote: string }>(
    `SELECT person_id, quote FROM (
       SELECT DISTINCT ON (person_id) person_id, quote, value FROM facts
        WHERE key = 'date_window' AND NOT retracted AND superseded_by IS NULL AND person_id = ANY($1)
          AND chat_id = $2 AND trip_id = $3
        ORDER BY person_id, observed_at DESC, id DESC
     ) latest
     WHERE quote IS NOT NULL AND quote <> '' AND value->>'earliest' IS NULL AND value->>'latest' IS NULL`,
    [ids, tc.chat.id, tc.trip.id],
  ).catch(() => []);
  return rows.map((r) => ({ label: tc.label(r.person_id), quote: r.quote.slice(0, 120) }));
}
