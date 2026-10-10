// Budgets from Nessie demo spending profiles: automatic linking when someone is first seen,
// per-person suggestions with a formula you can explain in three lines, adjust by text,
// "keep my budget private" (pooled-only from then on), a private breakdown over DM, and the
// pooled figure for the group. Every figure is registered for the money guard with its source.
import { now } from "../../clock.ts";
import { formatUsd } from "../../money/cents.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, getChat, getPerson, labelOf, type MessageRow } from "../../db/repos/core.ts";
import { rosterPersona } from "../../roster.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { budgetRows, effectiveCents, ensureBudgets, markAnnounced, pool, setAdjusted, setVisibility, type BudgetRow } from "../../nessie/budgets.ts";
import { ensureLink, linkFor, seedPerson } from "../../nessie/seed.ts";
import { tripFor } from "../../trips/state.ts";
import { isoDate } from "../../clock.ts";
import type { Action } from "../../transport/outbound.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { nameList } from "./planning.ts";
import type { Figure } from "../figures.ts";
import { ToolError, num, say, type Tool } from "../tools.ts";

const DISCLAIMER = "based on demo spending profiles (synthetic sandbox data, not your real bank)";

function sourceTag(r: BudgetRow): string {
  const s = r.inputs.source;
  if (s === "nessie") return `nessie:${r.inputs.customerId ?? "customer"}`;
  if (s === "nessie-cache") return `nessie-cache:${r.inputs.customerId ?? "customer"}`;
  return "estimate:offline demo profile";
}

export function budgetFigures(rows: BudgetRow[], label: (id: number) => string): Figure[] {
  const figures: Figure[] = [];
  for (const r of rows) {
    const cents = effectiveCents(r);
    if (cents === null) continue;
    figures.push({ cents, label: `${label(r.person_id)}'s trip budget`, source: sourceTag(r), visibility: r.visibility, ownerId: r.person_id });
    if (r.adjusted_cents !== null && r.suggested_cents !== null && r.visibility === "public") figures.push({ cents: r.suggested_cents, label: `${label(r.person_id)}'s suggested budget`, source: sourceTag(r), visibility: "public" });
  }
  if (rows.length >= 2) {
    const p = pool(rows);
    if (p.count >= 2 && !(p.anyPrivate && p.count < 3)) figures.push({ cents: p.ceilingCents, label: "the group's pooled per-person ceiling", source: "pooled:budgets", visibility: "public" });
    if (p.canShowRange && !p.anyPrivate) figures.push({ cents: p.minCents, label: "lowest budget", source: "pooled:budgets", visibility: "public" }, { cents: p.maxCents, label: "highest budget", source: "pooled:budgets", visibility: "public" });
  }
  return figures;
}

/** The group message, deterministic: the list, the number Atlas plans around, and (first time) how. */
export function budgetMessage(rows: BudgetRow[], label: (id: number) => string, opts: { firstTime: boolean }): string[] {
  if (rows.length === 0) return [];
  const p = pool(rows);
  const out: string[] = [];
  if (!p.anyPrivate) {
    const each = rows.map((r) => `${label(r.person_id).toLowerCase()}: ${formatUsd(effectiveCents(r)!)}`).join("\n");
    out.push(`💰 trip budgets\n${each}`);
    if (p.count >= 2) out.push(`so i'll plan around ${formatUsd(p.ceilingCents)} each, which works for everyone\n(from demo spending profiles, not your real bank)`);
    else out.push(`(from demo spending profiles, not your real bank)`);
  } else if (p.count >= 3) {
    out.push(`💰 someone's keeping their budget private, so here's just the pooled number:\neveryone's good up to ${formatUsd(p.ceilingCents)} each\n(from demo spending profiles, not your real bank)`);
  } else {
    out.push(`budgets stay pooled between you two (${DISCLAIMER}). i'll flag anything over what you can both do`);
  }
  if (opts.firstTime) {
    out.push(`how i got these: what you earn, minus bills and everyday spending, for each month until the trip, then half of that\nwant a different number? say "set my budget to ___" or "keep my budget private"`);
  }
  return out;
}

/** Below this nothing on the map is plannable (gas alone costs more); treat it as a joke, not a budget. */
export const MIN_BUDGET_CENTS = 50_00;

function tooLowReply(name: string, cents: number): string {
  return `${formatUsd(cents)} won't get anyone out of town 😅 ${name}, what's a real number? anything ${formatUsd(MIN_BUDGET_CENTS)}+ works`;
}

const LOADING_TEXT = "pulling demo spending profiles for";

/** Atlas already said it's pulling profiles a moment ago; saying it again reads like a stuck bot. */
function saidLoadingRecently(tc: TurnCtx): boolean {
  return tc.history.some((h) => h.direction === "outbound" && h.text.includes(LOADING_TEXT) && tc.now.getTime() - h.sent_at.getTime() < 10 * 60_000);
}

async function postBudgets(tc: TurnCtx, opts: { asked?: boolean } = {}): Promise<void> {
  const view = await tc.view();
  const tripStart = tc.trip.start_date ?? view.dates?.start ?? null;
  const { rows, pending } = await ensureBudgets(tc.trip.id, tc.members.map((m) => m.id), tc.today, tripStart);
  const label = (id: number) => tc.label(id);
  if (pending.length) {
    for (const id of pending) await enqueueJob("nessie.link", { personId: id }, { singletonKey: `nessie:${id}` });
    await enqueueJob("budgets.announce", { chatId: tc.chat.id, attempt: 0 }, { singletonKey: `budgets:${tc.chat.id}`, dueAt: new Date(tc.now.getTime() + 5_000) });
    if (saidLoadingRecently(tc)) {
      // Someone asked outright: answer, briefly. From a tool, say nothing and let the model talk.
      if (opts.asked) say(tc, "still pulling the demo profiles, everyone's budget will land here in a sec");
      return;
    }
    say(tc, `one sec, ${LOADING_TEXT} ${nameList(pending.map((id) => label(id).toLowerCase()))} from the nessie sandbox. i'll post everyone's budget right after`);
    return;
  }
  const firstTime = rows.some((r) => r.announced_at === null);
  tc.figures.addAll(budgetFigures(rows, label));
  say(tc, ...budgetMessage(rows, label, { firstTime }));
  await markAnnounced(tc.trip.id, rows.map((r) => r.person_id));
}

const showBudgets: Tool = {
  soloPost: true,
  decl: {
    name: "show_budgets",
    description: "Post everyone's suggested trip budget (from their Nessie demo spending profiles) and the pooled per-person figure. Respects private budgets. Use when budgets come up or before proposing options.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    const before = tc.out.length;
    await postBudgets(tc);
    if (tc.out.length === before) {
      return { ok: true, data: { loading: true }, next: "budgets are still loading and will post on their own in a moment; don't mention them again, just answer the rest in your own words" };
    }
    return { ok: true, posted: tc.out.slice(before).map((a) => (a.type === "say" ? a.text : "")), next: "budgets were posted; don't repeat the numbers" };
  },
};

const setMyBudget: Tool = {
  decl: {
    name: "set_my_budget",
    description: "Set the sender's own trip budget to an amount they stated (\"my budget is more like 600\"). Only the sender can change their own budget.",
    parameters: { type: "object", properties: { amount_usd: { type: "number" } }, required: ["amount_usd"] },
  },
  async run(args, ctx) {
    const amount = num(args.amount_usd);
    if (!amount || amount <= 0 || amount > 50_000) throw new ToolError("amount_usd must be a positive dollar amount");
    if (ctx.senderId === null) throw new ToolError("no sender");
    if (Math.round(amount * 100) < MIN_BUDGET_CENTS) throw new ToolError(`budgets under ${formatUsd(MIN_BUDGET_CENTS)} aren't realistic; ask what they really want to spend`);
    const row = await setAdjusted(ctx.senderId, ctx.trip.id, Math.round(amount * 100));
    const text = row.visibility === "private" ? "updated your budget (kept private)" : `done, your budget is now ${formatUsd(effectiveCents(row)!)} 👍`;
    say(ctx, text);
    ctx.figures.add({ cents: effectiveCents(row)!, label: "sender's budget", source: "user:stated", visibility: row.visibility, ownerId: ctx.senderId });
    return { ok: true, posted: [text] };
  },
};

async function privateBreakdown(personId: number): Promise<string[] | null> {
  // The person's most recent group trip with a budget row.
  const row = await one<BudgetRow & { chat_id: number }>(
    `SELECT b.*, t.chat_id FROM budgets b JOIN trips t ON t.id = b.trip_id WHERE b.person_id = $1 AND b.suggested_cents IS NOT NULL ORDER BY b.updated_at DESC LIMIT 1`,
    [personId],
  );
  if (!row?.inputs.result) return null;
  const r = row.inputs.result;
  const lines = [
    `your trip budget: ${formatUsd(effectiveCents(row)!)}${row.adjusted_cents !== null ? ` (you set it; the profile suggested ${formatUsd(row.suggested_cents!)})` : ""}. ${DISCLAIMER}`,
    ...r.explanation,
    `it's ${row.visibility}. "keep my budget private" / "make my budget public" switches it`,
  ];
  return lines;
}

export const budgetsFeature: Feature = {
  name: "budgets",
  tools: [showBudgets, setMyBudget],

  async onNewMember(_chatId, personId) {
    const person = await getPerson(personId);
    const link = await ensureLink(personId, { persona: person ? rosterPersona(person.handle) : undefined });
    if (link.seed_status !== "ready") await enqueueJob("nessie.link", { personId }, { singletonKey: `nessie:${personId}` });
  },

  jobs(svc) {
    return {
      "nessie.link": async (payload) => {
        await seedPerson(Number(payload.personId));
      },
      "budgets.announce": async (payload, { jobId }) => {
        const chatId = Number(payload.chatId);
        const attempt = Number(payload.attempt ?? 0);
        const chat = await getChat(chatId);
        if (!chat) return;
        const members = await activeMembers(chatId);
        const links = await Promise.all(members.map((m) => linkFor(m.id)));
        if (links.some((l) => !l || l.seed_status !== "ready")) {
          if (attempt >= 40) return;
          return { rescheduleAt: new Date(now().getTime() + 8_000), payload: { chatId, attempt: attempt + 1 } };
        }
        const trip = await tripFor(chatId);
        const today = isoDate(now(), chat.timezone);
        const { rows } = await ensureBudgets(trip.id, members.map((m) => m.id), today, trip.start_date);
        const byId = new Map(members.map((m) => [m.id, m]));
        const label = (id: number) => labelOf(byId.get(id) ?? { display_name: null, handle: null });
        const lines = budgetMessage(rows, label, { firstTime: rows.some((r) => r.announced_at === null) });
        await markAnnounced(trip.id, rows.map((r) => r.person_id));
        await svc.post(chatId, `budgets${jobId}-${attempt}`, lines.map((text): Action => ({ type: "say", text })));
      },
    };
  },

  commands: {
    budget_query: async (_msg, tc) => postBudgets(tc, { asked: true }),
    budget_private: async (msg, tc) => {
      if (msg.person_id === null) return;
      await setVisibility(msg.person_id, tc.trip.id, "private");
      say(tc, `got it ${tc.label(msg.person_id).toLowerCase()}, your budget stays private. i'll only ever use it in pooled numbers, and you can see yours by texting me directly`);
    },
    budget_public: async (msg, tc) => {
      if (msg.person_id === null) return;
      await setVisibility(msg.person_id, tc.trip.id, "public");
      say(tc, "ok, your budget is public again 👍");
    },
    budget_set: async (msg, tc, cmd) => {
      if (msg.person_id === null || cmd.kind !== "budget_set") return;
      if (cmd.amountCents < MIN_BUDGET_CENTS) {
        tc.figures.add({ cents: cmd.amountCents, label: "budget someone typed", source: "user:stated", visibility: "public" });
        say(tc, tooLowReply(tc.label(msg.person_id).toLowerCase(), cmd.amountCents));
        return;
      }
      const row = await setAdjusted(msg.person_id, tc.trip.id, cmd.amountCents);
      if (row.visibility === "private") say(tc, "updated your budget (kept private)");
      else {
        tc.figures.add({ cents: cmd.amountCents, label: "budget just set", source: "user:stated", visibility: "public" });
        say(tc, `done, ${tc.label(msg.person_id).toLowerCase()}'s budget is now ${formatUsd(cmd.amountCents)} 👍${tc.trip.status === "locked" ? "\n(the payment plan is based on trip cost, so it doesn't change)" : ""}`);
      }
    },
  },

  async figures(tc) {
    return budgetFigures(await budgetRows(tc.trip.id), (id) => tc.label(id));
  },

  async situation(tc) {
    const rows = new Map((await budgetRows(tc.trip.id)).map((r) => [r.person_id, r]));
    const lines: string[] = [];
    for (const m of tc.members) {
      const r = rows.get(m.id);
      const cents = r ? effectiveCents(r) : null;
      if (!r || cents === null) lines.push(`- ${tc.label(m.id)}: no budget yet (demo profile not linked or not computed; show_budgets computes it)`);
      else if (r.visibility === "private") lines.push(`- ${tc.label(m.id)}: PRIVATE — never mention it; pooled figures only`);
      else lines.push(`- ${tc.label(m.id)}: ${formatUsd(cents)}${r.adjusted_cents !== null ? " (set by them)" : " (suggested)"}, ${r.inputs.source === "offline-profile" ? "offline demo profile" : "nessie demo profile"}${r.announced_at ? "" : " — not shown to the group yet"}`);
    }
    const valid = [...rows.values()].filter((r) => effectiveCents(r) !== null);
    if (valid.length >= 2) lines.push(`pooled: everyone's comfortable up to ${formatUsd(pool(valid).ceilingCents)} per person`);
    return { title: "budgets (demo spending profiles from the nessie sandbox; say so when you mention them)", lines };
  },

  async summary(tc) {
    const rows = (await budgetRows(tc.trip.id)).filter((r) => effectiveCents(r) !== null);
    if (rows.length < 2) return [];
    return [`budget: everyone's comfortable up to ${formatUsd(pool(rows).ceilingCents)} per person (demo profiles)`];
  },

  async directMessage(msg: MessageRow, tc) {
    if (msg.person_id === null) return false;
    const t = msg.text.toLowerCase();
    if (/keep my budget private|make my budget private/.test(t) || /make my budget public/.test(t)) {
      const vis = /public/.test(t) ? "public" : "private";
      const trips = await q<{ trip_id: number }>(`SELECT DISTINCT t.id AS trip_id FROM trips t JOIN chat_members m ON m.chat_id = t.chat_id WHERE m.person_id = $1`, [msg.person_id]);
      for (const r of trips) await setVisibility(msg.person_id, r.trip_id, vis);
      say(tc, vis === "private" ? "done, your budget is private everywhere. groups only see pooled numbers" : "done, your budget is public again");
      return true;
    }
    if (/\b(my budget|what can i (spend|afford)|budget breakdown)\b/.test(t)) {
      const lines = await privateBreakdown(msg.person_id);
      if (!lines) {
        say(tc, "i don't have a budget for you yet. once you're in a group chat with me and budgets come up, i'll compute it from your demo spending profile");
        return true;
      }
      const row = await one<BudgetRow>(`SELECT * FROM budgets WHERE person_id = $1 AND suggested_cents IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [msg.person_id]);
      if (row?.inputs.result) {
        const r = row.inputs.result;
        for (const [cents, label] of [
          [effectiveCents(row)!, "your budget"],
          [r.suggestedCents, "suggested"],
          [r.monthlyIncomeCents, "income"],
          [r.monthlyBillsCents, "bills"],
          [r.monthlyDiscretionaryCents, "spending"],
          [r.monthlyFreeCents, "free"],
          [r.liquidBalanceCents, "balance"],
          [r.capCents, "cap"],
        ] as const) tc.figures.add({ cents, label, source: "nessie:dm", visibility: "private", ownerId: msg.person_id });
      }
      say(tc, lines.join("\n"));
      return true;
    }
    return false;
  },
};
