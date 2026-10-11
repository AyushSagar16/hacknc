// The agent's whole world for one turn, as plain text: who's here, where the trip stands,
// each person's resolved preferences (with their own words), what features contribute
// (budgets, polls, expenses, forecast, recalled memories), the figures it may quote, the
// recent chat and the new messages. Stateless: rebuilt from the database every turn.
import type { MessageRow } from "../db/repos/core.ts";
import type { Tension } from "../profile/extract.ts";
import type { PersonProfile } from "../profile/aggregate.ts";
import { askedFields } from "../profile/store.ts";
import type { AddressedReason } from "./addressed.ts";
import type { Feature, TurnCtx } from "./feature.ts";

const HISTORY_LINES = 30;

export async function describeSituation(
  tc: TurnCtx,
  opts: { remaining: MessageRow[]; reasons: Map<number, AddressedReason>; hints: string[]; tensions: Tension[]; features: Feature[]; agentName: string },
): Promise<string> {
  const { trip } = tc;
  const view = await tc.view();
  const profiles = await tc.profiles();
  const asked = await askedFields(tc.chat.id);
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
  const w = view.window;
  lines.push(
    `group date window: ${w.earliest || w.latest ? `${w.earliest ?? "?"} to ${w.latest ?? "?"}${w.conflict ? " (CONFLICT: windows don't overlap)" : ""} from ${w.knownFrom} of ${tc.members.length}` : "unknown"}${view.dates ? `; first workable dates ${view.dates.start} to ${view.dates.end} (${view.dates.nights} nights)` : ""}`,
  );
  if (view.missing.length) {
    lines.push(
      `still missing: ${view.missing
        .map((m) => `${m.label} (${m.fields.map((f) => (asked.has(`${m.personId}:${f}`) ? `${f}, already asked` : f)).join(", ")})`)
        .join("; ")}${view.majorityHasShared ? " — a majority has shared, don't wait on the rest" : ""}`,
    );
  }
  if (opts.tensions.length) lines.push(`tensions: ${opts.tensions.map((t) => `${t.topic} (${t.sides.map((s) => tc.label(s)).join(" vs ")})`).join("; ")}`);

  for (const f of opts.features) {
    if (!f.situation) continue;
    const section = await f.situation(tc);
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
  if (![...opts.reasons.values()].some((r) => r !== null)) {
    lines.push("", "note: these don't tag you. a quick check thought you might help, but it's often wrong: reply NO_REPLY unless the group clearly needs you, and keep it to one short bubble.");
  }
  return lines.join("\n");
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
