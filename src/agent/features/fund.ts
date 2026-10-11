// Where to stay and the trip fund.
//   find_stays: once the place and dates are settled, hotels and whole-home rentals for the dates
//     (SerpApi google_hotels, vacation_rentals=true; labeled estimates offline), sized for the
//     group and filtered to what the group can afford, three named options and a poll.
//   The winner (poll or book_stay) is booked: trips.stay, stage stay decided, "booked ✓", and the
//     stay goes on the trip fund.
//   The trip fund: a shared account per trip. Target = the stay + whatever the group puts on it
//     (add_to_fund). Everyone's share follows the trip's split mode; contributions go in on each
//     person's paydays before the deposit deadline (two weeks out), moved automatically by the
//     fund.collect job from their checking into the fund (tracked in the ledger for anyone with
//     no bank connected). The stay is paid from the fund once it's covered.
// Every figure posted is registered for the money guard; budgets are never named in the group.
import { daysBetween, isoDate, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, getChat, labelOf } from "../../db/repos/core.ts";
import { formatUsd } from "../../money/cents.ts";
import { budgetRows, effectiveCents } from "../../nessie/budgets.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { tripDestination } from "../../trips/place.ts";
import { createPoll, openPolls, type PollRow } from "../../trips/pollStore.ts";
import { setStage, stagesOf } from "../../trips/stages.ts";
import { findStays, type StayOption } from "../../trips/stays.ts";
import {
  addFundItem,
  contributionTotals,
  dueContributions,
  ensureFundAccount,
  executeContribution,
  fundItems,
  fundName,
  fundTotals,
  fundTxns,
  getFund,
  nextContributions,
  payDueItems,
  personBank,
  planContributions,
  removeUnpaidStay,
  type FundItemRow,
  type PersonContributions,
} from "../../trips/fund.ts";
import { tripById, updateTrip, type TripRow, type TripStay } from "../../trips/state.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import type { Figure } from "../figures.ts";
import { ToolError, num, say, str, strList, type Tool } from "../tools.ts";
import { formatRange, nameList } from "./planning.ts";
import { pricingDeps } from "./proposals.ts";

const log = () => childLog({ component: "fund" });

export const STAY_POLL_KIND = "stay";
export const FUND_COLLECT_JOB = "fund.collect";
export const FUND_MEMBERS_JOB = "fund.members";
/** The stay may take this much of what each person has left after their own travel. */
export const STAY_SHARE_OF_BUDGET = 0.5;

const first = (label: string) => label.toLowerCase().split(/\s+/)[0] ?? label.toLowerCase();
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
/** "friday" within the week, else "oct 24". */
export const whenText = (iso: string, today: string) => {
  const d = daysBetween(today, iso);
  return d === 0 ? "today" : d === 1 ? "tomorrow" : d > 1 && d < 7 ? weekday(iso) : day(iso);
};
const money = (c: number) => formatUsd(c, { cents: "auto" });

// ---------- stays ----------

/** What each person's stay may cost (whole stay): the tightest known budget less that person's travel, halved. */
async function stayCap(tc: TurnCtx): Promise<number | null> {
  const rows = await budgetRows(tc.trip.id);
  const travel = new Map((await q<{ person_id: number; est_cost_cents: number | null }>(`SELECT person_id, est_cost_cents FROM travel_plans WHERE trip_id = $1`, [tc.trip.id])).map((r) => [Number(r.person_id), Number(r.est_cost_cents ?? 0)]));
  const members = new Set(tc.members.map((m) => m.id));
  const caps = rows
    .filter((r) => members.has(r.person_id) && effectiveCents(r) !== null)
    .map((r) => Math.max(0, (effectiveCents(r)! - (travel.get(r.person_id) ?? 0)) * STAY_SHARE_OF_BUDGET));
  return caps.length ? Math.round(Math.min(...caps)) : null;
}

function stayFigures(o: StayOption): Figure[] {
  const source = o.source === "live" ? "live:serpapi" : "estimate:stay";
  return [
    { cents: o.totalCents, label: `${o.name} total`, source, visibility: "public" },
    { cents: o.perPersonCents, label: `${o.name} per person`, source, visibility: "public" },
    { cents: o.perPersonNightCents, label: `${o.name} per person per night`, source, visibility: "public" },
  ];
}

export function stayLine(o: StayOption, i: number): string {
  const what = o.kind === "rental" ? `whole place${o.sleeps ? `, sleeps ${o.sleeps}` : ""}` : `hotel, ${o.rooms} ${o.rooms === 1 ? "room" : "rooms"}`;
  const rating = o.rating ? ` · ★${o.rating.toFixed(1)}` : "";
  return `${i + 1}. ${o.name} · ${what} · ${money(o.perPersonNightCents)}/person/night${rating}\n${o.link}`;
}

const pollTitle = (o: StayOption) => `${o.name} (${money(o.perPersonNightCents)}/night pp)`;

async function postStayOptions(tc: TurnCtx): Promise<{ options: StayOption[]; live: boolean }> {
  const dest = tripDestination(tc.trip);
  if (!dest || !tc.trip.destination_name) throw new ToolError("no place is settled yet; settle where first");
  if (!tc.trip.start_date || !tc.trip.end_date) throw new ToolError("the trip has no dates yet; settle when first (find_dates)");
  const n = tc.members.length;
  const dates = { start: tc.trip.start_date, end: tc.trip.end_date };
  const cap = await stayCap(tc);
  const { options, live } = await findStays(dest, dates, n, cap, pricingDeps());
  if (options.length === 0) throw new ToolError("couldn't find anywhere to stay for those dates");
  await tc.nonCancellable();
  const poll = await createPoll({
    tripId: tc.trip.id,
    chatId: tc.chat.id,
    kind: STAY_POLL_KIND,
    title: "where should we stay?",
    options: options.map((o) => ({ title: pollTitle(o), ref: o, estimatedCostCents: o.perPersonCents })),
    at: tc.now,
  });
  await setStage(tc.trip.id, "stay", "in_progress");
  for (const o of options) tc.figures.addAll(stayFigures(o));
  const nights = daysBetween(dates.start, dates.end);
  const head = `🏠 places to stay in ${tc.trip.destination_name.toLowerCase().split(",")[0]}, ${formatRange(dates.start, dates.end)} (${nights} ${nights === 1 ? "night" : "nights"} for ${n})`;
  const notes: string[] = [];
  if (options.some((o) => o.overBudget)) notes.push("nothing fits everyone's budget, so these are the cheapest i found");
  else if (cap !== null) notes.push("all within what everyone said works");
  if (!live) notes.push("prices are estimates until we pick one");
  const foot = options.length > 1 ? "vote below 🗳️ the winner gets booked and goes on the trip fund" : `say "book it" and i'll book it on the trip fund`;
  say(tc, [head, ...options.map(stayLine), ...(notes.length ? [`(${notes.join("; ")})`] : []), foot].join("\n"));
  if (options.length > 1) tc.out.push({ type: "poll", title: "where should we stay? 🗳️", options: poll.options.map((o) => o.title), pollId: poll.id });
  return { options, live };
}

/** Book a stay option: save it on the trip, decide the stage, put it on the fund and post the plan. */
export async function bookStay(tc: TurnCtx, o: StayOption, how?: string): Promise<void> {
  if (!tc.trip.start_date || !tc.trip.end_date) throw new ToolError("the trip has no dates yet");
  await tc.nonCancellable();
  const stay: TripStay = {
    name: o.name,
    kind: o.kind,
    address: null,
    lat: o.lat,
    lon: o.lon,
    check_in: tc.trip.start_date,
    check_out: tc.trip.end_date,
    total_cents: o.totalCents,
    per_person_night_cents: o.perPersonNightCents,
    rating: o.rating,
    link: o.link,
    booked_at: tc.now.toISOString(),
  };
  await removeUnpaidStay(tc.trip.id);
  tc.trip = await updateTrip(tc.trip.id, { stay });
  const stages = await setStage(tc.trip.id, "stay", "decided", { force: true });
  tc.trip = { ...tc.trip, stages };
  for (const p of await openPolls(tc.chat.id, tc.trip.id)) if (p.kind === STAY_POLL_KIND) await q(`UPDATE polls SET status = 'closed', closed_at = $2 WHERE id = $1`, [p.id, tc.now]);
  await addFundItem({ tripId: tc.trip.id, kind: "stay", description: o.name, amountCents: o.totalCents, key: `stay:${tc.trip.id}:${o.name.toLowerCase()}:${stay.check_in}:${o.totalCents}`, sourceMessageId: tc.sourceMessageId });
  await ensureFundAccount(tc.trip);
  tc.figures.addAll(stayFigures(o));
  say(
    tc,
    `🏠 booked ✓ ${o.name}${how ? ` (${how})` : ""}\n${formatRange(stay.check_in!, stay.check_out!)} · ${money(o.totalCents)} total, ${money(o.perPersonCents)} each\n${o.link}`,
  );
  await postFundPlan(tc, { lead: "the stay's on the trip fund. balance is due as the fund fills up" });
}

// ---------- the fund plan ----------

/** One job per payday that has contributions due (idempotent per trip and day). */
async function scheduleCollect(tripId: number, chatId: number, dueDates: string[]): Promise<void> {
  for (const d of dueDates) await enqueueJob(FUND_COLLECT_JOB, { tripId, chatId }, { singletonKey: `fund-collect:${tripId}:${d}`, dueAt: new Date(`${d}T13:00:00Z`) });
}

/** "$1,076 for the stay + $240 boat rental". */
export function targetText(items: Pick<FundItemRow, "kind" | "description" | "amount_cents">[]): string {
  return items.map((i) => (i.kind === "stay" ? `${money(i.amount_cents)} for the stay` : `${money(i.amount_cents)} ${i.description.toLowerCase()}`)).join(" + ");
}

/** "2 × $179.50 (oct 17, oct 31)" / "$359 on oct 17" / "all in ✓". */
export function scheduleText(p: Pick<PersonContributions, "plan" | "shareCents" | "contributedCents">): string {
  if (p.plan.length === 0) return p.contributedCents >= p.shareCents ? "all in ✓" : "nothing due";
  const dates = p.plan.map((i) => day(i.dueDate)).join(", ");
  if (p.plan.length === 1) return `${money(p.plan[0]!.amountCents)} on ${dates}`;
  const same = p.plan.every((i) => i.amountCents === p.plan[0]!.amountCents);
  if (same) return `${p.plan.length} × ${money(p.plan[0]!.amountCents)} (${dates})`;
  // The odd cents ride on the first payment: "$137.79, then 2 × $137.77 (oct 17, oct 31, nov 14)".
  const rest = p.plan.slice(1);
  if (rest.length > 1 && rest.every((i) => i.amountCents === rest[0]!.amountCents)) return `${money(p.plan[0]!.amountCents)}, then ${rest.length} × ${money(rest[0]!.amountCents)} (${dates})`;
  return p.plan.map((i) => `${money(i.amountCents)} ${day(i.dueDate)}`).join(", ");
}

/** One line naming whoever's committed total is above their budget. Private budgets: name only. */
async function overBudget(tc: TurnCtx, shares: Map<number, number>): Promise<string | null> {
  const travel = new Map((await q<{ person_id: number; est_cost_cents: number | null }>(`SELECT person_id, est_cost_cents FROM travel_plans WHERE trip_id = $1`, [tc.trip.id])).map((r) => [Number(r.person_id), Number(r.est_cost_cents ?? 0)]));
  const rows = (await budgetRows(tc.trip.id)).filter((r) => effectiveCents(r) !== null && (shares.get(r.person_id) ?? 0) + (travel.get(r.person_id) ?? 0) > effectiveCents(r)!);
  if (!rows.length) return null;
  const pub = rows.filter((r) => r.visibility !== "private").map((r) => first(tc.label(r.person_id)));
  const priv = rows.filter((r) => r.visibility === "private").map((r) => first(tc.label(r.person_id)));
  const out: string[] = [];
  if (pub.length) out.push(`heads up: with travel this is over budget for ${nameList(pub)}. say so and we can look at something cheaper`);
  if (priv.length) out.push(`heads up ${nameList(priv)}, with travel this is above what you said works for you. say the word and we can look at something cheaper`);
  return out.join("\n");
}

function planFigures(tc: TurnCtx, people: PersonContributions[], target: number, collected: number): void {
  tc.figures.add({ cents: target, label: "trip fund target", source: "ledger:fund", visibility: "public" });
  tc.figures.add({ cents: collected, label: "trip fund collected", source: "ledger:fund", visibility: "public" });
  for (const p of people) {
    tc.figures.add({ cents: p.shareCents, label: `${tc.label(p.personId)}'s fund share`, source: "ledger:fund", visibility: "public" });
    tc.figures.add({ cents: p.contributedCents, label: `${tc.label(p.personId)} put in so far`, source: "ledger:fund", visibility: "public" });
    for (const i of p.plan) tc.figures.add({ cents: i.amountCents, label: `${tc.label(p.personId)} contribution`, source: "ledger:fund", visibility: "public" });
  }
}

/**
 * (Re)plan everyone's contributions and post it. In full: the target, each person's share and
 * payments, where the money moves. `compact` (a change): the header and one short line.
 */
export async function postFundPlan(tc: TurnCtx, opts: { compact?: boolean; lead?: string } = {}): Promise<boolean> {
  const items = await fundItems(tc.trip.id);
  if (!items.length) return false;
  await tc.nonCancellable();
  const { people, deadline, dueDates } = await planContributions(tc.trip, tc.members.map((m) => m.id), tc.today);
  await scheduleCollect(tc.trip.id, tc.chat.id, dueDates);
  const totals = await fundTotals(tc.trip.id);
  planFigures(tc, people, totals.targetCents, totals.collectedCents);
  for (const i of items) tc.figures.add({ cents: i.amount_cents, label: `fund item: ${i.description}`, source: "ledger:fund", visibility: "public" });
  const name = fundName(tc.trip).toLowerCase();
  const header = `🏦 ${name}: ${money(totals.targetCents)} (${targetText(items)})`;
  // Equal to the cent, give or take the odd cent a split can't divide.
  const amounts = people.map((p) => p.shareCents);
  const equal = Math.max(...amounts) - Math.min(...amounts) <= 1;
  const typical = [...amounts].sort((a, b) => amounts.filter((x) => x === b).length - amounts.filter((x) => x === a).length)[0]!;
  const timed = people.filter((p) => !p.unchanged && p.plan.length > 0);
  const cadence = people.every((p) => p.plan.length <= 1)
    ? "in one payment"
    : timed.length === 0 || timed.every((p) => p.onPaydays)
      ? "in small payments on your paydays"
      : timed.some((p) => p.onPaydays)
        ? "in small payments, on paydays where i know them"
        : "in small payments every two weeks";
  const intro = `${equal ? `everyone puts in ${money(typical)}` : "shares below"}, ${cadence}, all in by ${day(deadline)}`;
  const ledgerOnly = people.filter((p) => !p.connected);
  const where =
    ledgerOnly.length === people.length
      ? "(i'm tracking the fund here for now)"
      : ledgerOnly.length
        ? `(it moves from your checking into the fund on those days. ${nameList(ledgerOnly.map((p) => first(tc.label(p.personId))))}, no bank's connected for you, so i'll just track yours here)`
        : "(it moves from each of your checking accounts into the fund on those days)";
  const shares = new Map(people.map((p) => [p.personId, p.shareCents]));
  const over = await overBudget(tc, shares);
  const lines = people.map((p) => `${first(tc.label(p.personId))}: ${equal ? "" : `${money(p.shareCents)} · `}${scheduleText(p)}`);
  if (opts.compact) {
    say(tc, [header, intro, ...(equal ? [] : lines)].join("\n"), ...(over ? [over] : []));
    return true;
  }
  say(tc, [...(opts.lead ? [opts.lead] : []), header, intro, ...lines, where].join("\n"), ...(over ? [over] : []));
  return true;
}

/** "leo's next $90 goes in friday"; several on one day: "next ones go in oct 17: maya $164.46, leo $164.45". */
function nextText(next: [number, { dueDate: string; amountCents: number }][], tc: Pick<TurnCtx, "label" | "today">): string {
  const soonest = next[0]![1].dueDate;
  const due = next.filter(([, n]) => n.dueDate === soonest);
  if (due.length === 1) return `${first(tc.label(due[0]![0]))}'s next ${money(due[0]![1].amountCents)} goes in ${whenText(soonest, tc.today)}`;
  return `next ones go in ${whenText(soonest, tc.today)}: ${due.map(([id, n]) => `${first(tc.label(id))} ${money(n.amountCents)}`).join(", ")}`;
}

/** The status line: "fund's at $840 / $1,200, leo's next $90 goes in friday". */
export async function fundStatus(tc: Pick<TurnCtx, "trip" | "label" | "today" | "figures">): Promise<string | null> {
  const items = await fundItems(tc.trip.id);
  const fund = await getFund(tc.trip.id);
  if (!items.length || !fund) return null;
  const totals = await fundTotals(tc.trip.id);
  tc.figures.add({ cents: totals.targetCents, label: "trip fund target", source: "ledger:fund", visibility: "public" });
  tc.figures.add({ cents: totals.collectedCents, label: "trip fund collected", source: "ledger:fund", visibility: "public" });
  const next = [...(await nextContributions(tc.trip.id))].sort((a, b) => a[1].dueDate.localeCompare(b[1].dueDate));
  for (const [, n] of next) tc.figures.add({ cents: n.amountCents, label: "next contribution", source: "ledger:fund", visibility: "public" });
  const lines = [`🏦 fund's at ${money(totals.collectedCents)} / ${money(totals.targetCents)}${next.length ? `, ${nextText(next, tc)}` : totals.collectedCents >= totals.targetCents ? ", fully funded ✓" : ""}`];
  for (const i of items) {
    tc.figures.add({ cents: i.amount_cents, label: `fund item: ${i.description}`, source: "ledger:fund", visibility: "public" });
    lines.push(`${i.kind === "stay" ? "🏠 " : "• "}${i.description}: ${money(i.amount_cents)}${i.paid_at ? ", paid ✓" : i.kind === "stay" ? ", booked, paid from the fund once it's covered" : ", paid from the fund once it's covered"}`);
  }
  return lines.join("\n");
}

// ---------- tools ----------

const findStaysTool: Tool = {
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "find_stays",
    description:
      "Once the place and dates are settled: find places to stay (hotels and whole-home rentals) for the dates, sized for the group and within what everyone can afford, and post three named options (price per person per night, rating, link) with a poll. The winner gets booked on the trip fund. Use when the stay is the next thing to settle or someone asks where we're staying.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    const { options } = await postStayOptions(tc);
    return { ok: true, data: { options: options.map((o) => ({ name: o.name, kind: o.kind, per_person_night: money(o.perPersonNightCents), total: money(o.totalCents) })) }, next: "the options and poll were posted; reply NO_REPLY. wait for the group to pick one before anything else (no day-by-day plan yet)" };
  },
};

const bookStayTool: Tool = {
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "book_stay",
    description: "Book one of the stay options already posted when the group agrees on it in words (\"let's do the townhouse\", \"book it\"). Votes on the poll book it on their own.",
    parameters: { type: "object", properties: { option: { type: "string", description: "the option's number (1-3) or name" } }, required: ["option"] },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const poll = (await q<PollRow>(`SELECT * FROM polls WHERE trip_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`, [tc.trip.id, STAY_POLL_KIND]))[0];
    if (!poll) throw new ToolError("no stay options were posted yet; call find_stays first");
    const want = str(args.option) ?? String(num(args.option) ?? "");
    const n = Number(want);
    const idx = Number.isInteger(n) && n >= 1 && n <= poll.options.length ? n - 1 : poll.options.findIndex((o) => o.title.toLowerCase().includes(want.toLowerCase()) || want.toLowerCase().includes(String((o.ref as StayOption).name ?? "").toLowerCase()));
    const option = poll.options[idx]?.ref as StayOption | undefined;
    if (!option) throw new ToolError(`no stay option matches "${want}"`);
    await bookStay(tc, option);
    return { ok: true, next: "booked and the fund plan was posted; reply NO_REPLY" };
  },
};

const addToFundTool: Tool = {
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "add_to_fund",
    description:
      "Put a shared cost on the trip fund (\"put the boat rental on the fund, it's 240\", \"add the cabin cleaning fee\"): raises the fund's target, re-plans everyone's contributions and posts the new shares. Only for costs the group shares ahead of time; something one person already paid is log_expense.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        amount_usd: { type: "number", description: "the whole cost" },
        shared_by: { type: "array", items: { type: "string" }, description: "first names when only some of the group share it; omit for everyone" },
      },
      required: ["description", "amount_usd"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const amount = num(args.amount_usd);
    const description = str(args.description);
    if (!amount || amount <= 0 || !description) throw new ToolError("need a description and a positive amount_usd");
    if (!tc.trip.destination_name) throw new ToolError("no place is settled yet, so there's no trip fund");
    const sharedBy = strList(args.shared_by).map((s) => {
      const id = tc.resolve(s);
      if (id === undefined) throw new ToolError(`${s} isn't in this chat`);
      return id;
    });
    await tc.nonCancellable();
    const cents = Math.round(amount * 100);
    const { created } = await addFundItem({ tripId: tc.trip.id, kind: "item", description, amountCents: cents, sharedBy: sharedBy.length ? [...new Set(sharedBy)] : null, key: `funditem:${tc.trip.id}:${tc.sourceMessageId ?? `t${tc.turnId}`}:${description.toLowerCase()}`, sourceMessageId: tc.sourceMessageId });
    if (!created) return { ok: true, next: "already on the fund from this message; reply NO_REPLY" };
    await ensureFundAccount(tc.trip);
    tc.figures.add({ cents, label: `fund item: ${description}`, source: "user:stated", visibility: "public" });
    await postFundPlan(tc, { compact: true });
    return { ok: true, next: "the new fund plan was posted; reply NO_REPLY" };
  },
};

const showFundTool: Tool = {
  soloPost: true,
  decl: {
    name: "show_fund",
    description: "Post where the trip fund stands: collected vs target, who puts in what next and when, and whether the stay is paid. Use for \"how's the fund\", \"how much is in the pot\", \"when do i pay\".",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    const text = await fundStatus(tc);
    if (!text) throw new ToolError("there's no trip fund yet: it starts when the stay is booked (find_stays) or something goes on it (add_to_fund)");
    say(tc, text);
    return { ok: true, posted: [text] };
  },
};

const showPaymentPlanTool: Tool = {
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "show_payment_plan",
    description: "Post the whole trip-fund schedule again (each person's share and payments on their paydays). Only when someone asks to SEE the plan or what everyone pays; for a quick status use show_fund.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    if (!(await postFundPlan(tc))) throw new ToolError("there's no trip fund yet: it starts when the stay is booked (find_stays)");
    return { ok: true, next: "posted" };
  },
};

// ---------- jobs ----------

async function labeler(chatId: number): Promise<(id: number | null) => string> {
  const members = await activeMembers(chatId);
  const extra = await q<{ id: number; display_name: string | null; handle: string | null }>(`SELECT id, display_name, handle FROM people WHERE id IN (SELECT person_id FROM fund_txns f JOIN trips t ON t.id = f.trip_id WHERE t.chat_id = $1 AND person_id IS NOT NULL)`, [chatId]);
  const byId = new Map<number, { display_name: string | null; handle: string | null }>([...extra.map((p) => [Number(p.id), p] as const), ...members.map((m) => [m.id, m] as const)]);
  return (id) => first(labelOf(byId.get(id ?? -1) ?? { display_name: null, handle: null }));
}

/** Move every contribution that's due, pay what the fund now covers, and say it in one message. */
export async function collectFund(svc: Pick<AppServices, "post">, tripId: number, chatId: number, guid: string): Promise<string | null> {
  const trip = await tripById(tripId);
  if (!trip || trip.status === "done") return null;
  const chat = await getChat(chatId);
  const today = isoDate(now(), chat?.timezone ?? "UTC");
  const label = await labeler(chatId);
  // One amount per person, even when a catch-up run moves several of their payments at once.
  const bankBy = new Map<number, number>();
  const ledgerBy = new Map<number, number>();
  let failed = false;
  for (const t of await dueContributions(tripId, today)) {
    try {
      const done = await executeContribution(t, trip);
      const { connected } = await personBank(t.person_id!, null);
      const into = done.via === "bank" || connected ? bankBy : ledgerBy;
      into.set(t.person_id!, (into.get(t.person_id!) ?? 0) + t.amount_cents);
    } catch (err) {
      failed = true;
      log().warn({ err: (err as Error).message, txn: t.id }, "contribution transfer failed; retrying later");
    }
  }
  const bank = [...bankBy].map(([id, c]) => `${label(id)} ${money(c)}`);
  const ledger = [...ledgerBy].map(([id, c]) => `${label(id)} ${money(c)}`);
  if (failed) await enqueueJob(FUND_COLLECT_JOB, { tripId, chatId }, { singletonKey: `fund-collect:${tripId}:retry`, dueAt: new Date(now().getTime() + 30 * 60_000) });
  const paid = await payDueItems(trip);
  if (!bank.length && !ledger.length && !paid.length) return null;
  const totals = await fundTotals(tripId);
  const lines: string[] = [];
  if (bank.length) lines.push(`💸 trip fund: ${nameList(bank)} went in ✓`);
  if (ledger.length) lines.push(`${bank.length ? "" : "💸 trip fund: "}${nameList(ledger)} ${ledger.length === 1 ? "is" : "are"} due, marked as in (no bank connected, so i'm just tracking ${ledger.length === 1 ? "it" : "those"})`);
  lines.push(`fund's at ${money(totals.collectedCents)} / ${money(totals.targetCents)}`);
  for (const i of paid) lines.push(`${i.kind === "stay" ? "🏠" : "✓"} ${i.description} is paid in full from the fund ✓`);
  const text = lines.join("\n");
  await svc.post(chatId, guid, [{ type: "say", text }]);
  return text;
}

/** Someone joined or left after the fund was planned: re-plan and say it in one line. */
export async function reconcileFundMembers(svc: Pick<AppServices, "post">, tripId: number, chatId: number, guid: string): Promise<string | null> {
  const trip = await tripById(tripId);
  if (!trip || ["done", "settling"].includes(trip.status)) return null;
  const before = await contributionTotals(tripId);
  if (before.size === 0) return null;
  const members = await activeMembers(chatId);
  const ids = members.map((m) => m.id);
  const gone = [...before.keys()].filter((id) => !ids.includes(id));
  const joined = ids.filter((id) => !before.has(id));
  if (!gone.length && !joined.length) return null;
  const chat = await getChat(chatId);
  const today = isoDate(now(), chat?.timezone ?? "UTC");
  const label = await labeler(chatId);
  const { people, dueDates } = await planContributions(trip, ids, today);
  await scheduleCollect(tripId, chatId, dueDates);
  const lines: string[] = [];
  if (gone.length) lines.push(`took ${nameList(gone.map((id) => label(id)))} off the trip fund`);
  for (const id of joined) {
    const p = people.find((x) => x.personId === id);
    if (p) lines.push(`added ${label(id)} to the trip fund: ${money(p.shareCents)}, ${scheduleText(p)}`);
  }
  const others = people.filter((p) => !joined.includes(p.personId));
  if (others.length && !others.every((p) => p.unchanged)) lines.push(`everyone else's share is now ${new Set(others.map((p) => p.shareCents)).size === 1 ? money(others[0]!.shareCents) : "updated"}`);
  const text = lines.join("\n");
  if (text) await svc.post(chatId, guid, [{ type: "say", text }]);
  return text || null;
}

// ---------- feature ----------

export const fundFeature: Feature = {
  name: "fund",
  tools: [findStaysTool, bookStayTool, addToFundTool, showFundTool, showPaymentPlanTool],

  async onPollDecided(poll: PollRow, winnerIdx: number, tc: TurnCtx) {
    if (poll.kind !== STAY_POLL_KIND) return false;
    const option = poll.options[winnerIdx]?.ref as StayOption | undefined;
    if (!option) return true;
    const votes = await one<{ n: number }>(`SELECT count(DISTINCT person_id)::int AS n FROM votes WHERE poll_id = $1 AND option_idx = $2 AND selected`, [poll.id, winnerIdx]);
    const n = tc.members.length;
    const count = votes?.n ?? 0;
    await bookStay(tc, option, count >= n && n > 1 ? "unanimous" : `${count} of ${n} votes`);
    return true;
  },

  // The stay was un-decided (new place or dates): take it off the fund. Membership changed: re-plan.
  async afterTurn(tc) {
    try {
      const trip = await tripById(tc.trip.id);
      if (!trip) return;
      if (trip.stay && stagesOf(trip).stay !== "decided") {
        await removeUnpaidStay(trip.id);
        await updateTrip(trip.id, { stay: null });
        if ((await fundItems(trip.id)).length === 0) await q(`UPDATE fund_txns SET status = 'cancelled' WHERE trip_id = $1 AND kind = 'contribution' AND status = 'scheduled'`, [trip.id]);
        else await enqueueJob(FUND_MEMBERS_JOB, { tripId: trip.id, chatId: tc.chat.id, replan: true }, { singletonKey: `fund-members:${trip.id}` });
      }
      if (["done", "settling"].includes(trip.status)) return;
      const totals = await contributionTotals(trip.id);
      if (totals.size === 0) return;
      const active = new Set(tc.members.map((m) => m.id));
      const drift = [...totals.keys()].some((id) => !active.has(id)) || [...active].some((id) => !totals.has(id));
      if (drift) await enqueueJob(FUND_MEMBERS_JOB, { tripId: trip.id, chatId: tc.chat.id }, { singletonKey: `fund-members:${trip.id}` });
    } catch (err) {
      log().warn({ err: (err as Error).message }, "fund check after the turn failed");
    }
  },

  async figures(tc) {
    const out: Figure[] = [];
    const totals = await fundTotals(tc.trip.id);
    if (totals.targetCents || totals.collectedCents) {
      out.push({ cents: totals.targetCents, label: "trip fund target", source: "ledger:fund", visibility: "public" });
      out.push({ cents: totals.collectedCents, label: "trip fund collected", source: "ledger:fund", visibility: "public" });
      out.push({ cents: Math.max(0, totals.targetCents - totals.collectedCents), label: "trip fund still to collect", source: "ledger:fund", visibility: "public" });
    }
    for (const i of await fundItems(tc.trip.id)) out.push({ cents: i.amount_cents, label: `fund item: ${i.description}`, source: "ledger:fund", visibility: "public" });
    for (const t of await fundTxns(tc.trip.id)) out.push({ cents: t.amount_cents, label: `fund ${t.kind}`, source: "ledger:fund", visibility: "public" });
    for (const [id, c] of await contributionTotals(tc.trip.id)) out.push({ cents: c, label: `${tc.label(id)}'s fund share`, source: "ledger:fund", visibility: "public" });
    const stay = tc.trip.stay;
    if (stay?.total_cents) out.push({ cents: stay.total_cents, label: "stay total", source: "ledger:stay", visibility: "public" });
    if (stay?.per_person_night_cents) out.push({ cents: stay.per_person_night_cents, label: "stay per person per night", source: "ledger:stay", visibility: "public" });
    const poll = (await openPolls(tc.chat.id, tc.trip.id)).find((p) => p.kind === STAY_POLL_KIND);
    for (const o of poll?.options ?? []) out.push(...stayFigures(o.ref as StayOption));
    return out;
  },

  async situation(tc) {
    const lines: string[] = [];
    const stay = tc.trip.stay;
    if (stay) lines.push(`stay booked: ${stay.name} (${stay.kind}), ${stay.check_in && stay.check_out ? formatRange(stay.check_in, stay.check_out) : ""}${stay.total_cents ? `, ${money(stay.total_cents)} total` : ""}`);
    const poll = (await openPolls(tc.chat.id, tc.trip.id)).find((p) => p.kind === STAY_POLL_KIND);
    if (poll) lines.push(`stay poll open: ${poll.options.map((o, i) => `${i + 1}. ${o.title}`).join("; ")}. votes book it; book_stay when they agree in words`);
    const items = await fundItems(tc.trip.id);
    if (items.length) {
      const totals = await fundTotals(tc.trip.id);
      lines.push(`trip fund: ${money(totals.collectedCents)} collected of ${money(totals.targetCents)} (${targetText(items)}); pays for: ${items.map((i) => `${i.description}${i.paid_at ? " (paid)" : ""}`).join(", ")}`);
      const next = await nextContributions(tc.trip.id);
      if (next.size) lines.push(`next contributions: ${[...next].map(([id, n]) => `${tc.label(id)} ${money(n.amountCents)} on ${n.dueDate}`).join(", ")}`);
      lines.push("status: show_fund. full schedule: show_payment_plan. a shared cost the group wants on the fund: add_to_fund");
    }
    return lines.length ? { title: "stay and trip fund", lines } : null;
  },

  async summary(tc) {
    const out: string[] = [];
    if (tc.trip.stay) out.push(`staying at: ${tc.trip.stay.name}`);
    const totals = await fundTotals(tc.trip.id);
    if (totals.targetCents) out.push(`trip fund: ${money(totals.collectedCents)} / ${money(totals.targetCents)}`);
    return out;
  },

  jobs(svc: AppServices) {
    return {
      [FUND_COLLECT_JOB]: async (payload, { jobId }) => {
        await collectFund(svc, Number(payload.tripId), Number(payload.chatId), `fundcollect${jobId}`);
      },
      [FUND_MEMBERS_JOB]: async (payload, { jobId }) => {
        const tripId = Number(payload.tripId);
        const chatId = Number(payload.chatId);
        if (payload.replan) {
          const trip = await tripById(tripId);
          const chat = await getChat(chatId);
          if (trip) {
            const { dueDates } = await planContributions(trip, (await activeMembers(chatId)).map((m) => m.id), isoDate(now(), chat?.timezone ?? "UTC"));
            await scheduleCollect(tripId, chatId, dueDates);
          }
        }
        await reconcileFundMembers(svc, tripId, chatId, `fundmembers${jobId}`);
      },
    };
  },
};
