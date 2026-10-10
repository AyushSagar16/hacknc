// One turn of Atlas, in a fixed order:
//   intro (once) → per-message commands and fast paths (no model) → extraction in parallel with
//   the addressed check + deterministic hints + speak gate → agent with tools → money guard.
// Money and constraints are decided by code; the models only read and write language.
import type { Config } from "../config.ts";
import { isoDate, now as clockNow } from "../clock.ts";
import { childLog } from "../log.ts";
import { one, q } from "../db/pool.ts";
import { activeMembers, labelOf, markIntroSent, recentMessages, setQuiet, type MemberRow, type MessageRow } from "../db/repos/core.ts";
import { extractFacts, markExtracted, type Tension } from "../profile/extract.ts";
import { groupView } from "../profile/groupView.ts";
import { profilesFor } from "../profile/store.ts";
import type { TurnHandler, TurnInput, TurnResult } from "../pipeline/pipeline.ts";
import { advanceTripStatus, tripFor } from "../trips/state.ts";
import { addressedReason } from "./addressed.ts";
import { guardBubbles, runAgent } from "./agent.ts";
import { parseCommand, type Command } from "./commands.ts";
import type { Feature, TurnCtx } from "./feature.ts";
import { Figures } from "./figures.ts";
import type { Llm } from "./llm.ts";
import { nameList } from "./features/planning.ts";
import { warmMemory } from "./features/memory.ts";
import { describeSituation } from "./situation.ts";
import { isSmallTalk } from "./smallTalk.ts";
import { RECENT_MESSAGE_COUNT, speakGate } from "./speakGate.ts";
import { ToolRegistry, say } from "./tools.ts";

export interface BrainDeps {
  cfg: Config;
  llm: Llm;
  features: Feature[];
}

export const UNPROMPTED_PER_HOUR = 12;

export function introLines(agentName: string): string[] {
  const n = agentName.toLowerCase();
  return [
    `hi, i'm ${n}, your trip and financial planner 👋 i'll keep track of what everyone wants and can spend, and help you all actually book this thing`,
    `i read along and jump in when it helps the plan. tag me ("${n}") anytime, or tell me to stay quiet.\nbudgets i suggest come from demo spending profiles (sandbox data, not your real bank), and "keep my budget private" means i only ever use yours pooled`,
    `so where are we thinking, and when?`,
  ];
}

export function createBrain(deps: BrainDeps): TurnHandler {
  const { cfg, llm, features } = deps;
  const tools = new ToolRegistry();
  for (const f of features) if (f.tools) tools.add(...f.tools);
  const agentName = cfg.AGENT_NAME;

  return async (input: TurnInput): Promise<TurnResult> => {
    let ctxRef: TurnCtx | undefined;
    const result = await turn(input, (tc) => (ctxRef = tc));
    if (ctxRef) for (const f of features) if (f.afterTurn) await f.afterTurn(ctxRef).catch(() => {});
    return result;
  };

  async function turn(input: TurnInput, expose: (tc: TurnCtx) => void): Promise<TurnResult> {
    const log = childLog({ component: "brain", chatId: input.chat.id, turnId: input.turnId });
    const { chat } = input;
    const now = clockNow();
    const today = isoDate(now, chat.timezone);
    const [tripRow, members, history] = await Promise.all([tripFor(chat.id), activeMembers(chat.id), recentMessages(chat.id, 40)]);
    let trip = await advanceTripStatus(tripRow, today);
    const byId = new Map<number, MemberRow>(members.map((m) => [m.id, m]));
    const label = (id: number | null) => (id === null ? agentName.toLowerCase() : labelOf(byId.get(id) ?? { display_name: null, handle: null }));
    const firstNames = new Map<number, string>(members.map((m) => [m.id, label(m.id).toLowerCase().split(/\s+/)[0] ?? ""]));

    // A promise, so callers racing in parallel (situation, hints) share one query.
    let profilesCache: ReturnType<typeof profilesFor> | undefined;
    const figures = new Figures();
    const tc: TurnCtx = {
      cfg,
      llm,
      chat,
      trip,
      turnId: input.turnId,
      senderId: null,
      sourceMessageId: null,
      members,
      label,
      resolve: (name) => {
        const n = name.trim().toLowerCase().replace(/^@/, "");
        if (n === "me" || n === "i" || n === "myself") return tc.senderId ?? undefined;
        for (const [id, first] of firstNames) if (first === n || label(id).toLowerCase() === n) return id;
        return undefined;
      },
      figures,
      out: [],
      now,
      today,
      nonCancellable: input.nonCancellable,
      notes: new Map(),
      batch: input.batch,
      history,
      consumed: new Set(),
      features,
      profiles: () => (profilesCache ??= profilesFor(members.map((m) => m.id))),
      view: async () => {
        const profiles = await tc.profiles();
        return groupView(
          members.map((m) => ({ personId: m.id, label: label(m.id), profile: profiles.get(m.id)! })),
          today,
        );
      },
    };
    expose(tc);
    const refreshTrip = async () => {
      tc.trip = await tripFor(chat.id);
    };
    for (const figs of await Promise.all(features.map((f) => (f.figures ? f.figures(tc) : [])))) figures.addAll(figs);

    // ---------- private chats ----------
    if (!chat.is_group) {
      // Late deliveries (e.g. a text Linq held until the sender was registered) aren't answered.
      for (const msg of input.batch.filter((m) => m.kind === "text" && m.speakable)) {
        tc.senderId = msg.person_id;
        tc.sourceMessageId = msg.id;
        let handled = false;
        for (const f of features) if (!handled && f.directMessage) handled = await f.directMessage(msg, tc);
        if (!handled) {
          const firstTime = !history.some((h) => h.direction === "outbound");
          say(
            tc,
            firstTime
              ? `hey! i'm ${agentName.toLowerCase()}, a trip + money planner for group chats. add this number to your friends' group chat and i'll take it from there`
              : `i do my planning inside group chats, so add me to yours and say hi.\nin here i can walk you through your own budget, just ask "what's my budget"`,
          );
        }
      }
      return { actions: tc.out, route: "dm" };
    }

    // ---------- intro ----------
    const actions = tc.out;
    let route = "silent";
    if (!chat.intro_sent_at && (await markIntroSent(chat.id, now))) {
      say(tc, ...introLines(agentName));
      route = "intro";
    }

    // ---------- extraction runs alongside everything below ----------
    const extraction = runExtraction(tc, llm, cfg, agentName).catch((err) => {
      log.warn({ err: (err as Error).message }, "extraction crashed");
      return { tensions: [] as Tension[], newConstraints: false };
    });

    // ---------- deterministic per-message handling ----------
    const remaining: MessageRow[] = [];
    for (const msg of input.batch) {
      tc.senderId = msg.person_id;
      tc.sourceMessageId = msg.id;
      if (msg.kind === "membership") {
        if (msg.meta?.change === "added" && route !== "intro" && chat.intro_sent_at) {
          // The message's person is whoever did the adding; the newcomers are in meta.handles.
          const handles = (msg.meta?.handles as string[] | undefined) ?? [];
          const added = members.filter((m) => m.handle && handles.includes(m.handle)).map((m) => firstNames.get(m.id) ?? "").filter((n) => /^[a-z]/.test(n));
          const who = added.length && added.length <= 3 ? ` ${nameList(added)}` : "";
          say(tc, `welcome${who}! i'm ${agentName.toLowerCase()}, i keep the trip + money side organized.\nsay "${agentName.toLowerCase()} summarize" and i'll catch you up`);
          route = "welcome";
        }
        tc.consumed.add(msg.id);
        continue;
      }
      let handled = false;
      for (const f of features) if (!handled && f.fastPath) handled = await f.fastPath(msg, tc);
      if (handled) {
        tc.consumed.add(msg.id);
        route = route === "silent" ? "fast_path" : route;
        continue;
      }
      if (msg.kind !== "text") continue;
      const reason = addressedReason({ message: msg, history, agentName, namesById: firstNames });
      const cmd = parseCommand(msg.text, { addressed: reason !== null });
      if (cmd && msg.speakable) {
        await runCommand(cmd, msg, tc, features, agentName);
        tc.consumed.add(msg.id);
        route = "command";
        await refreshTrip();
        continue;
      }
      if (msg.speakable) remaining.push(msg);
    }

    // ---------- a follow-up with no new messages (the group went quiet, or atlas came back online) ----------
    if (input.nudge && input.batch.length === 0) {
      await extraction;
      return followUp(tc, input.nudge, input, log);
    }

    if (remaining.length === 0) {
      await extraction;
      return { actions, route };
    }

    // ---------- should Atlas speak? ----------
    const reasons = new Map(remaining.map((m) => [m.id, addressedReason({ message: m, history, agentName, namesById: firstNames })]));
    const addressedMsgs = remaining.filter((m) => reasons.get(m.id) !== null);
    const explicitlyAddressed = remaining.some((m) => reasons.get(m.id) === "named" || reasons.get(m.id) === "reply_to_atlas");
    const addressed = addressedMsgs.length > 0;
    if (addressed) {
      // Addressed always speaks: show typing now and overlap the memory recall with extraction.
      input.typing?.();
      warmMemory(tc);
    }
    const quiet = chat.quiet_mode;
    const [hintLists, unprompted] = await Promise.all([Promise.all(features.map((f) => (f.hints ? f.hints(tc) : []))), unpromptedLastHour(chat.id, now)]);
    const hints: string[] = hintLists.flat();

    let gate: { decision: string; reason: string } | undefined;
    let speak = addressed;
    if (!addressed && quiet) {
      await extraction;
      return { actions, route: route === "silent" ? "quiet" : route, addressed: false };
    }
    // Laughter and acks with nothing pending: no gate call (the deterministic triggers below still run).
    const smallTalk = !addressed && hints.length === 0 && remaining.every((m) => isSmallTalk(m.text));
    if (!addressed && !smallTalk) {
      const lastAtlas = [...history].reverse().find((h) => h.direction === "outbound");
      const verdict = await speakGate(
        llm,
        cfg.GEMINI_MODEL_GATE,
        {
          atlasHasSpoken: history.some((h) => h.direction === "outbound"),
          stage: trip.status,
          facts: tripFacts(tc),
          hints,
          minutesSinceAtlasSpoke: lastAtlas ? Math.round((now.getTime() - lastAtlas.sent_at.getTime()) / 60_000) : null,
          unpromptedLastHour: unprompted,
          recent: history.slice(-RECENT_MESSAGE_COUNT).map((h) => ({ label: label(h.person_id), text: h.text })),
          newest: remaining.map((m) => ({ label: label(m.person_id), text: m.text })),
        },
        { chatId: chat.id, turnId: input.turnId },
      );
      gate = { decision: verdict.speak ? "SPEAK" : "NO_REPLY", reason: verdict.reason };
      speak = verdict.speak && unprompted < UNPROMPTED_PER_HOUR;
    }

    const extracted = await extraction;
    profilesCache = undefined; // new facts landed
    if (!speak && !addressed && !quiet && unprompted < UNPROMPTED_PER_HOUR) {
      // A disagreement or a plan-breaking constraint is worth one unprompted line even if the gate passed.
      for (const f of features) if (!speak && f.proactive) speak = await f.proactive(tc);
      if (!speak && extracted.tensions.length > 0 && minutesSinceAtlas(history, now) > 10) {
        speak = true;
        hints.push(`people disagree right now: ${extracted.tensions.map((t) => `${t.topic} (${t.sides.map((s) => label(s)).join(" vs ")})`).join("; ")}`);
      }
      if (speak) gate = { decision: "SPEAK", reason: "deterministic trigger" };
    }
    if (!speak) return { actions, route: route === "silent" ? "gate_silent" : route, addressed, gate };
    input.typing?.();

    // ---------- the agent ----------
    const lead = remaining[remaining.length - 1]!;
    tc.senderId = (addressedMsgs[addressedMsgs.length - 1] ?? lead).person_id;
    tc.sourceMessageId = (addressedMsgs[addressedMsgs.length - 1] ?? lead).id;
    await refreshTrip();
    const speakingBecause = addressed ? undefined : gate?.reason === "deterministic trigger" ? "something just changed the plan (see heads up)" : gate?.reason;
    const situation = await describeSituation(tc, { remaining, reasons, hints, tensions: extracted.tensions, features, agentName, speakingBecause });
    const toolStart = actions.length;
    const out = await runAgent({ llm, model: cfg.GEMINI_MODEL_AGENT, situation, tools, ctx: tc, signal: input.signal, agentName, mustAnswer: explicitlyAddressed });
    if (out.failed) {
      if (explicitlyAddressed) say(tc, out.failed === "no_key" ? "my language brain isn't connected right now (no gemini key) — commands like \"summarize\", \"what's our budget\" and \"settle up\" still work" : "sorry, my brain glitched for a sec — say that again?");
      return { actions, route: "agent_failed", addressed, gate };
    }
    let bubbles = addressed ? out.bubbles : out.bubbles.slice(0, 1);
    // A tool already posted the question/breakdown: the model's lead-in would only repeat it.
    if (out.soloPosted || (!addressed && actions.length > toolStart)) bubbles = [];
    const guarded = guardBubbles(bubbles, figures, { isGroup: true });
    if (guarded.violations.length) {
      log.warn({ violations: guarded.violations }, "money guard dropped the model's text");
      await q(`INSERT INTO llm_traces (role, model, chat_id, turn_id, decision, reason, created_at) VALUES ('guard', 'money-guard', $1, $2, 'blocked', $3, $4)`, [
        chat.id,
        input.turnId,
        guarded.violations.join("; ").slice(0, 500),
        now,
      ]);
      bubbles = guarded.bubbles;
      if (bubbles.length === 0 && actions.length === toolStart && explicitlyAddressed) bubbles = [`i don't want to guess at numbers. ask me "what's our budget" or "who owes who" and i'll pull them exactly`];
    }
    // Named directly and the model still came back empty: a plain next step beats silence.
    if (out.empty && explicitlyAddressed && actions.length === toolStart) {
      log.warn({ retried: out.retried }, "agent stayed empty when addressed; sending the deterministic next step");
      bubbles = [await nextStepLine(tc, features)];
    }
    // The model's words go first, then whatever its tools posted.
    const toolPosts = actions.splice(toolStart);
    for (const b of bubbles) actions.push({ type: "say", text: b });
    actions.push(...toolPosts);
    return { actions, route: "agent", addressed, gate };
  }

  /** Nobody said anything new: look at where the plan stands and move it one step, or stay quiet. */
  async function followUp(tc: TurnCtx, why: string, input: TurnInput, log: ReturnType<typeof childLog>): Promise<TurnResult> {
    const { chat, out: actions } = tc;
    const gate = (decision: string) => ({ decision, reason: `follow-up: ${why}`.slice(0, 200) });
    if (chat.quiet_mode) return { actions, route: "nudge_quiet", addressed: false };
    if ((await unpromptedLastHour(chat.id, tc.now)) >= UNPROMPTED_PER_HOUR) return { actions, route: "nudge_capped", addressed: false };
    const hints = [why];
    for (const f of features) if (f.hints) hints.push(...(await f.hints(tc)));
    const situation = await describeSituation(tc, { remaining: [], reasons: new Map(), hints, tensions: [], features, agentName });
    const toolStart = actions.length;
    const out = await runAgent({ llm, model: cfg.GEMINI_MODEL_AGENT, situation, tools, ctx: tc, signal: input.signal, agentName });
    if (out.failed) return { actions, route: "nudge_failed", addressed: false, gate: gate("NO_REPLY") };
    const toolPosts = actions.splice(toolStart);
    const guarded = guardBubbles(out.soloPosted || toolPosts.length ? [] : out.bubbles.slice(0, 2), tc.figures, { isGroup: true });
    if (guarded.violations.length) log.warn({ violations: guarded.violations }, "money guard dropped the follow-up text");
    for (const b of guarded.bubbles) actions.push({ type: "say", text: b });
    actions.push(...toolPosts);
    const spoke = actions.length > toolStart;
    return { actions, route: spoke ? "nudge" : "nudge_silent", addressed: false, gate: gate(spoke ? "SPEAK" : "NO_REPLY") };
  }
}

async function runCommand(cmd: Command, msg: MessageRow, tc: TurnCtx, features: Feature[], agentName: string): Promise<void> {
  const n = agentName.toLowerCase();
  switch (cmd.kind) {
    case "quiet":
      await setQuiet(tc.chat.id, true);
      tc.chat.quiet_mode = true;
      say(tc, `got it, i'll stay quiet unless someone tags me 🤐\n"${n} you can talk again" brings me back`);
      return;
    case "unquiet":
      await setQuiet(tc.chat.id, false);
      tc.chat.quiet_mode = false;
      say(tc, "i'm back! i'll jump in when it helps the plan");
      return;
    case "help":
      say(
        tc,
        `i handle the trip and the money side:\n- options with prices, then a poll\n- budgets from demo spending profiles\n- payment plans, splitting expenses, settling up\ntry "${n} summarize", "what's our budget", "i paid 64 for dinner" or "settle up". "${n} stay quiet" if i'm too chatty`,
      );
      return;
    case "summarize": {
      const lines: string[] = [];
      for (const f of features) if (f.summary) lines.push(...(await f.summary(tc)));
      say(tc, lines.length ? `here's where we are:\n${lines.map((l) => `- ${l}`).join("\n")}` : "nothing planned yet! where are we thinking, and when?");
      return;
    }
    default:
      for (const f of features) {
        const handler = f.commands?.[cmd.kind];
        if (handler) {
          await handler(msg, tc, cmd);
          return;
        }
      }
      say(tc, "i can't do that one yet");
  }
}

/** What to say when Atlas was named but the model produced nothing: where things stand and who's next. */
export async function nextStepLine(tc: TurnCtx, features: Feature[]): Promise<string> {
  const lines: string[] = [];
  for (const f of features) if (f.summary) lines.push(...(await f.summary(tc).catch(() => [] as string[])));
  if (lines.length === 0) return "i'm here! where are we thinking, and when?";
  return `i'm here. where things stand:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

async function runExtraction(tc: TurnCtx, llm: Llm, cfg: Config, agentName: string): Promise<{ tensions: Tension[]; newConstraints: boolean }> {
  // Everything not yet read: this batch plus anything a failed earlier extraction left behind.
  const pending = await q<MessageRow>(
    `SELECT * FROM messages WHERE chat_id = $1 AND direction = 'inbound' AND kind = 'text' AND extracted_at IS NULL
       AND sent_at > $2 ORDER BY sent_at, id LIMIT 30`,
    [tc.chat.id, new Date(tc.now.getTime() - 6 * 3_600_000)],
  );
  if (pending.length === 0) return { tensions: [], newConstraints: false };
  if (pending.every((m) => isSmallTalk(m.text))) {
    await markExtracted(pending.map((m) => m.id), tc.now);
    return { tensions: [], newConstraints: false };
  }
  const firstId = pending[0]!.id;
  const context = tc.history.filter((h) => h.id < firstId).slice(-6);
  const privateRows = await q<{ person_id: number }>(`SELECT person_id FROM budgets WHERE trip_id = $1 AND visibility = 'private'`, [tc.trip.id]);
  const result = await extractFacts({
    llm,
    model: cfg.GEMINI_MODEL_EXTRACT,
    chatId: tc.chat.id,
    turnId: tc.turnId,
    messages: pending,
    context,
    members: tc.members,
    today: tc.today,
    timezone: tc.chat.timezone,
    agentName,
    label: tc.label,
    privateBudgetPeople: new Set(privateRows.map((r) => r.person_id)),
  });
  if (!result.failed) await markExtracted(pending.map((m) => m.id), tc.now);
  const constraintFacts = result.factIds.length
    ? await one<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE id = ANY($1) AND (polarity = 'negative' OR key IN ('dietary','travel_limit','date_window','blackout'))`, [result.factIds])
    : undefined;
  return { tensions: result.tensions, newConstraints: (constraintFacts?.n ?? 0) > 0 };
}

function tripFacts(tc: TurnCtx): string[] {
  const t = tc.trip;
  const out: string[] = [];
  if (t.destination_name) out.push(`destination: ${t.destination_name}`);
  if (t.start_date && t.end_date) out.push(`dates: ${t.start_date} to ${t.end_date}`);
  out.push(`people in the chat: ${tc.members.length}`);
  return out;
}

async function unpromptedLastHour(chatId: number, now: Date): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM turns WHERE chat_id = $1 AND route IN ('agent', 'nudge') AND addressed = false AND started_at > $2`,
    [chatId, new Date(now.getTime() - 3_600_000)],
  );
  return row?.n ?? 0;
}

function minutesSinceAtlas(history: MessageRow[], now: Date): number {
  const last = [...history].reverse().find((h) => h.direction === "outbound");
  return last ? (now.getTime() - last.sent_at.getTime()) / 60_000 : Number.POSITIVE_INFINITY;
}
