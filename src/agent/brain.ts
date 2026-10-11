// One turn of Atlas, in a fixed order:
//   intro (once) → per-message commands and fast paths (no model) → extraction in parallel with
//   the addressed check + deterministic hints + speak gate → agent with tools → money guard.
// When a turn ends with Atlas saying nothing, a message that gave it something (an answer to its
// question, a date, a preference) gets a 👍 tapback, so the group can see Atlas read it.
// A private 1:1 chat runs the same turn as a party of one: every message is addressed to Atlas,
// banking and the person's own budget answer first, and a trip planned there is a solo trip.
// Money and constraints are decided by code; the models only read and write language.
import type { Config } from "../config.ts";
import { isoDate, now as clockNow } from "../clock.ts";
import { childLog } from "../log.ts";
import { one, q } from "../db/pool.ts";
import { activeMembers, labelOf, markIntroSent, recentMessages, setQuiet, type MemberRow, type MessageRow } from "../db/repos/core.ts";
import { extractFacts, markExtracted, type KnownSoFar, type Tension } from "../profile/extract.ts";
import { groupView } from "../profile/groupView.ts";
import { profilesFor } from "../profile/store.ts";
import type { TurnHandler, TurnInput, TurnResult } from "../pipeline/pipeline.ts";
import { advanceTripStatus, tripFor } from "../trips/state.ts";
import { addressedReason, type AddressedReason } from "./addressed.ts";
import { dropUnknownClaims, guardBubbles, runAgent } from "./agent.ts";
import { parseCommand, type Command } from "./commands.ts";
import type { Feature, TurnCtx } from "./feature.ts";
import { Figures } from "./figures.ts";
import type { Llm } from "./llm.ts";
import { nameList } from "./features/planning.ts";
import { CONNECT_QUESTION, isConnected, offerConnect } from "./features/connect.ts";
import { NAME_QUESTION, recordNameAsks, unnamed } from "./features/names.ts";
import { warmMemory } from "./features/memory.ts";
import { oneSiteLink } from "./links.ts";
import { describeSituation } from "./situation.ts";
import { isSmallTalk } from "./smallTalk.ts";
import { mentionsTrip, RECENT_MESSAGE_COUNT, roomNeedsAtlas, speakGate } from "./speakGate.ts";
import { ToolRegistry, say } from "./tools.ts";
import type { Action } from "../transport/outbound.ts";

export interface BrainDeps {
  cfg: Config;
  llm: Llm;
  features: Feature[];
}

export const UNPROMPTED_PER_HOUR = 12;
/**
 * How long a reply waits for this turn's extraction. Extraction on a struggling model took 24–36 s
 * live, and the reply doesn't need it: the new messages are in the situation verbatim. Past this,
 * the agent runs on the profiles from before and extraction finishes in the background.
 */
export const EXTRACTION_WAIT_MS = 4_000;
/** One retry of a failed agent call (quota/overload), after this pause. */
const AGENT_RETRY_MS = 3_000;
/** How far back a reply is compared with Atlas's own messages, to avoid restating one. */
const REPEAT_WINDOW_MESSAGES = 8;
/** At most this many 👍 acknowledgements per turn (one per person). */
export const MAX_ACKS_PER_TURN = 4;
/** A silent reply waits this long for extraction, to know which messages gave Atlas something. */
const ACK_EXTRACTION_WAIT_MS = 20_000;

/** The intro. `askNames`: some members are only phone numbers to Atlas, so it asks who's who first. */
export function introLines(agentName: string, opts: { askNames?: boolean } = {}): string[] {
  const n = agentName.toLowerCase();
  return [
    `hi, i'm ${n}, your trip and financial planner 👋 i'll keep track of what everyone wants and can spend, and help you all actually book this thing`,
    `i read along and jump in when it helps the plan. tag me ("${n}") anytime, or tell me to stay quiet.\neveryone's budget stays private: the group only ever sees pooled numbers`,
    ...(opts.askNames ? [NAME_QUESTION] : []),
    `so where are we thinking, and when?\nalso, ${CONNECT_QUESTION}`,
  ];
}

/** The first message in a private chat: what Atlas does one-on-one. */
export function dmIntroLines(agentName: string, opts: { askName?: boolean; askConnect?: boolean } = {}): string[] {
  const n = agentName.toLowerCase();
  return [
    `hey, i'm ${n} 👋 in here it's just you and me`,
    `i can check your balances, spending and bills, move money between your checking and savings, or plan a solo trip with you.\nfor a trip with friends, add me to your group chat`,
    ...(opts.askName ? [NAME_QUESTION] : []),
    opts.askConnect ? CONNECT_QUESTION : `try "what's my balance" or "help me plan a weekend away"`,
  ];
}

/** "atlas", "hey atlas!", "hi": a hello with nothing to answer beyond the intro. */
export function isBareGreeting(text: string, agentName: string): boolean {
  const n = agentName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rest = text
    .toLowerCase()
    .replace(new RegExp(`@?\\b${n}\\b`, "g"), " ")
    .replace(/\b(?:hey+|hi+|hello|yo+|sup|wassup|what'?s up|hiya|howdy|there|good (?:morning|afternoon|evening))\b/g, " ")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return rest === "";
}

export function createBrain(deps: BrainDeps): TurnHandler & { settle(): Promise<void> } {
  const { cfg, llm, features } = deps;
  const tools = new ToolRegistry();
  for (const f of features) if (f.tools) tools.add(...f.tools);
  const agentName = cfg.AGENT_NAME;
  /** The extraction in flight per chat: the next turn's waits for it so no message is read twice. */
  const extracting = new Map<number, Promise<unknown>>();

  const handler = async (input: TurnInput): Promise<TurnResult> => {
    let ctxRef: TurnCtx | undefined;
    const result = await turn(input, (tc) => (ctxRef = tc));
    result.actions = oneSiteLink(result.actions, cfg.SITE_BASE_URL);
    if (ctxRef) for (const f of features) if (f.afterTurn) await f.afterTurn(ctxRef).catch(() => {});
    return result;
  };
  // Extraction can outlive its turn (see EXTRACTION_WAIT_MS); shutdown waits for it so a write never
  // lands after the database is closed (or, in the simulator, in the next session's database).
  return Object.assign(handler, { settle: async () => void (await Promise.allSettled([...extracting.values()])) });

  async function turn(input: TurnInput, expose: (tc: TurnCtx) => void): Promise<TurnResult> {
    const log = childLog({ component: "brain", chatId: input.chat.id, turnId: input.turnId });
    const { chat } = input;
    const now = clockNow();
    const today = isoDate(now, chat.timezone);
    const [tripRow, members, rawHistory] = await Promise.all([tripFor(chat.id), activeMembers(chat.id), recentMessages(chat.id, 40)]);
    // Atlas's own tapbacks aren't things it said: they'd read as its last message.
    const history = rawHistory.filter((h) => !(h.direction === "outbound" && h.kind === "reaction"));
    let trip = await advanceTripStatus(tripRow, today);
    const byId = new Map<number, MemberRow>(members.map((m) => [m.id, m]));
    const label = (id: number | null) => (id === null ? agentName.toLowerCase() : labelOf(byId.get(id) ?? { display_name: null, handle: null }));
    const firstNames = new Map<number, string>(members.map((m) => [m.id, label(m.id).toLowerCase().split(/\s+/)[0] ?? ""]));

    // A promise, so callers racing in parallel (situation, hints) share one query. Keyed by trip:
    // a tool that starts or switches trips mid-turn changes which facts count.
    let profilesCache: { tripId: number; promise: ReturnType<typeof profilesFor> } | undefined;
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
      profiles: () => {
        if (profilesCache?.tripId !== tc.trip.id) profilesCache = { tripId: tc.trip.id, promise: profilesFor(members.map((m) => m.id), { chatId: chat.id, tripId: tc.trip.id }) };
        return profilesCache.promise;
      },
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

    // ---------- intro ----------
    const actions = tc.out;
    let route = "silent";
    const dm = !chat.is_group;
    if (dm && !chat.intro_sent_at && input.batch.some((m) => m.kind === "text" && m.speakable && m.person_id !== null) && (await markIntroSent(chat.id, now))) {
      chat.intro_sent_at = now;
      const nameless = unnamed(members);
      const owner = members[0];
      say(tc, ...dmIntroLines(agentName, { askName: nameless.length > 0, askConnect: owner ? !(await isConnected(owner.id)) : false }));
      await recordNameAsks(chat.id, nameless.map((m) => m.id), now);
      // A hello gets just the intro; anything else ("what's my balance") is answered below too.
      for (const m of input.batch) if (m.kind === "text" && isBareGreeting(m.text, agentName)) tc.consumed.add(m.id);
      route = "intro";
    } else if (!dm && !chat.intro_sent_at && (await markIntroSent(chat.id, now))) {
      const nameless = unnamed(members);
      say(tc, ...introLines(agentName, { askNames: nameless.length > 0 }));
      await recordNameAsks(chat.id, nameless.map((m) => m.id), now);
      await offerConnect(chat.id, members.map((m) => m.id), now);
      route = "intro";
    }

    // ---------- extraction runs alongside everything below ----------
    const previous = extracting.get(chat.id) ?? Promise.resolve();
    const extraction = previous
      .catch(() => {})
      .then(() => runExtraction(tc, llm, cfg, agentName))
      .catch((err) => {
        log.warn({ err: (err as Error).message }, "extraction crashed");
        return { tensions: [] as Tension[], newConstraints: false, factMessageIds: [] as number[] } satisfies Extracted;
      });
    extracting.set(chat.id, extraction);
    void extraction.finally(() => {
      if (extracting.get(chat.id) === extraction) extracting.delete(chat.id);
    });

    // ---------- deterministic per-message handling ----------
    const remaining: MessageRow[] = [];
    /** In a private chat every message is to Atlas. */
    const reasonFor = (m: MessageRow): AddressedReason => (dm ? "named" : addressedReason({ message: m, history, agentName, namesById: firstNames }));
    for (const msg of input.batch) {
      tc.senderId = msg.person_id;
      tc.sourceMessageId = msg.id;
      if (tc.consumed.has(msg.id)) continue;
      if (dm && msg.kind === "text" && msg.speakable) {
        // Banking and their own budget: answered by code before anything else.
        let mine = false;
        for (const f of features) if (!mine && f.directMessage) mine = await f.directMessage(msg, tc);
        if (mine) {
          tc.consumed.add(msg.id);
          route = route === "silent" ? "dm_fast_path" : route;
          continue;
        }
      }
      if (msg.kind === "membership") {
        if (msg.meta?.change === "added" && route !== "intro" && chat.intro_sent_at) {
          // The message's person is whoever did the adding; the newcomers are in meta.handles.
          const handles = (msg.meta?.handles as string[] | undefined) ?? [];
          const newcomers = members.filter((m) => m.handle && handles.includes(m.handle));
          const added = newcomers.map((m) => firstNames.get(m.id) ?? "").filter((n) => /^[a-z]/.test(n));
          const who = added.length && added.length <= 3 ? ` ${nameList(added)}` : "";
          // Late joiners get the same bank-connect question as everyone at the intro, and the name
          // question when Atlas only has their number.
          const nameless = unnamed(newcomers);
          if (nameless.length) {
            say(tc, `welcome! i'm ${agentName.toLowerCase()}, i keep the trip + money side organized. say "${agentName.toLowerCase()} summarize" and i'll catch you up\n${NAME_QUESTION}`);
            await recordNameAsks(chat.id, nameless.map((m) => m.id), now);
            say(tc, `${who ? `${who.trim()}, ` : ""}${CONNECT_QUESTION}`);
          } else say(tc, `welcome${who}! i'm ${agentName.toLowerCase()}, i keep the trip + money side organized. say "${agentName.toLowerCase()} summarize" and i'll catch you up\n${who ? `${who.trim()}, ` : ""}${CONNECT_QUESTION}`);
          await offerConnect(chat.id, newcomers.map((m) => m.id), now);
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
      const reason = reasonFor(msg);
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
      // Everything was handled by commands and fast paths: send that now, and let extraction
      // finish in the background ("keep my budget private" waited 39 s on a slow extract call).
      if (actions.length === 0) await extraction;
      return { actions, route };
    }

    // ---------- should Atlas speak? ----------
    const reasons = new Map(remaining.map((m) => [m.id, reasonFor(m)]));
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
      if (actions.length === 0) await extraction;
      return { actions, route: route === "silent" ? "quiet" : route, addressed: false };
    }
    const memberNames = [...firstNames.values()].filter(Boolean);
    // A trip/money question to the room, an objection or a change of mind always gets an answer:
    // no gate call to get wrong (or to fail on a 429).
    const needsAtlas = addressed ? null : [...remaining].reverse().map((m) => ({ m, why: roomNeedsAtlas(m.text, memberNames) })).find((x) => x.why);
    if (needsAtlas?.why) {
      gate = { decision: "SPEAK", reason: `${firstNames.get(needsAtlas.m.person_id ?? -1) ?? "someone"} ${needsAtlas.why}`.slice(0, 200) };
      speak = unprompted < UNPROMPTED_PER_HOUR;
    }
    // Laughter and acks with nothing pending: no gate call (the deterministic triggers below still run).
    const smallTalk = !addressed && hints.length === 0 && remaining.every((m) => isSmallTalk(m.text));
    // Untagged chatter with no trip or money words ("did anyone watch the game") isn't Atlas's to
    // answer, whatever a gate model might say: no gate call, and no reply. Extraction still reads it.
    const offTopic = !addressed && !needsAtlas && remaining.every((m) => !mentionsTrip(m.text));
    if (!addressed && !smallTalk && !needsAtlas && !offTopic) {
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
          memberNames,
        },
        { chatId: chat.id, turnId: input.turnId },
      );
      gate = { decision: verdict.speak ? "SPEAK" : "NO_REPLY", reason: verdict.reason };
      speak = verdict.speak && unprompted < UNPROMPTED_PER_HOUR;
    }

    // Replying: don't hold the first bubble for a slow extraction. Staying quiet: wait, because
    // what extraction finds (a fresh disagreement) can still be a reason to speak.
    const settled = speak ? await within(extraction, EXTRACTION_WAIT_MS) : await extraction;
    const extracted = settled ?? { tensions: [] as Tension[], newConstraints: false, factMessageIds: [] as number[] };
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
    if (!speak) {
      if (!quiet) acknowledge(actions, remaining.filter((m) => extracted.factMessageIds.includes(m.id)));
      return { actions, route: route === "silent" ? "gate_silent" : route, addressed, gate };
    }
    input.typing?.();

    // ---------- the agent ----------
    const lead = remaining[remaining.length - 1]!;
    tc.senderId = (addressedMsgs[addressedMsgs.length - 1] ?? lead).person_id;
    tc.sourceMessageId = (addressedMsgs[addressedMsgs.length - 1] ?? lead).id;
    await refreshTrip();
    const speakingBecause = addressed ? undefined : gate?.reason === "deterministic trigger" ? "something just changed the plan (see heads up)" : gate?.reason;
    const situation = await describeSituation(tc, { remaining, reasons, hints, tensions: extracted.tensions, features, agentName, speakingBecause });
    const toolStart = actions.length;
    if (!settled) {
      // The situation went out with the profiles from before this batch; tools (who's still missing
      // what, dates) read them after extraction lands, so nobody is asked for what they just said.
      const fresh = () => profilesFor(members.map((m) => m.id), { chatId: chat.id, tripId: tc.trip.id });
      profilesCache = undefined;
      tc.profiles = () => {
        if (profilesCache?.tripId !== tc.trip.id) profilesCache = { tripId: tc.trip.id, promise: extraction.then(fresh, fresh) };
        return profilesCache.promise;
      };
    }
    const agentRun = () => runAgent({ llm, model: cfg.GEMINI_MODEL_AGENT, situation, tools, ctx: tc, signal: input.signal, agentName, mustAnswer: explicitlyAddressed || Boolean(needsAtlas) });
    let out = await agentRun();
    // A quota or overload error on a reply someone is waiting for: one retry after a short pause,
    // unless a tool already did something this turn.
    if (out.failed && out.failed !== "no_key" && out.failed !== "refused" && actions.length === toolStart && (addressed || needsAtlas) && !input.signal.aborted) {
      log.warn({ kind: out.failed }, "agent call failed; retrying once");
      await new Promise((r) => setTimeout(r, AGENT_RETRY_MS));
      if (!input.signal.aborted) out = await agentRun();
    }
    if (out.failed) {
      if (actions.length === toolStart && (explicitlyAddressed || needsAtlas)) {
        say(tc, out.failed === "no_key" ? "my language brain isn't connected right now (no gemini key) — commands like \"summarize\", \"what's our budget\" and \"settle up\" still work" : "sorry, my brain glitched for a sec — say that again?");
      } else if (!quiet) acknowledge(actions, await ackable(remaining, settled, extraction));
      return { actions, route: "agent_failed", addressed, gate };
    }
    let bubbles = addressed ? out.bubbles : out.bubbles.slice(0, 1);
    // Never claim someone's dates or home city that nobody has given ("ravi's dates are set too").
    const known = (await tc.view()).members.map((m) => ({ name: firstNames.get(m.personId) ?? "", dates: Boolean(m.profile.earliest || m.profile.latest), city: Boolean(m.profile.homeCity) }));
    const claims = dropUnknownClaims(bubbles.join("\n\n"), known);
    if (claims.dropped.length) {
      log.warn({ dropped: claims.dropped }, "agent stated a person's dates/city nobody gave; cut it");
      bubbles = claims.text ? claims.text.split(/\n\s*\n/) : [];
    }
    // A tool already posted the question/breakdown: the model's lead-in would only repeat it.
    if (out.soloPosted || (!addressed && actions.length > toolStart)) bubbles = [];
    // A tool asked the group something ("omar, nina wants to make it $54.00… reply yes"): the model's
    // own question ("want me to update it?") would be a second prompt for the same answer.
    if (actions.length > toolStart && actions.slice(toolStart).some((a) => a.type === "say" && asksForAnswer(a.text))) bubbles = bubbles.filter((b) => !/\?\s*$/.test(b));
    // Unprompted, never restate something Atlas just said.
    if (!explicitlyAddressed) bubbles = bubbles.filter((b) => !repeatsRecent(b, history));
    const guarded = guardBubbles(bubbles, figures, audienceOf(tc));
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
    // Nothing to say (waiting on the rest of the group, say): a 👍 shows the message landed.
    if (!quiet && !actions.some(visible)) acknowledge(actions, await ackable(remaining, settled, extraction));
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
    // A follow-up that restates an earlier Atlas message is a nag ("sol and ravi, cast your votes…"
    // then "sol and ravi, drop your votes…" two minutes later): drop it.
    const fresh = (out.soloPosted || toolPosts.length ? [] : out.bubbles.slice(0, 2)).filter((b) => !repeatsRecent(b, tc.history));
    const guarded = guardBubbles(fresh, tc.figures, audienceOf(tc));
    if (guarded.violations.length) log.warn({ violations: guarded.violations }, "money guard dropped the follow-up text");
    for (const b of guarded.bubbles) actions.push({ type: "say", text: b });
    actions.push(...toolPosts);
    const spoke = actions.length > toolStart;
    return { actions, route: spoke ? "nudge" : "nudge_silent", addressed: false, gate: gate(spoke ? "SPEAK" : "NO_REPLY") };
  }
}

/** Who sees the reply: the group, or in a private chat only the person it's with. */
export function audienceOf(tc: Pick<TurnCtx, "chat" | "members" | "senderId">): { isGroup: boolean; viewerId?: number } {
  if (tc.chat.is_group) return { isGroup: true };
  return { isGroup: false, viewerId: tc.senderId ?? tc.members[0]?.id };
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
      if (!tc.chat.is_group) {
        say(
          tc,
          `in here it's just you and me:\n- your balances, spending, bills and recent transactions\n- moving money between your checking and savings\n- your trip budget, from your last few months of spending\n- planning a solo trip: options, a place to stay, food and a day-by-day plan\ntry "what's my balance", "move 100 to savings" or "plan me a beach weekend"`,
        );
        return;
      }
      say(
        tc,
        `i handle the trip and the money side:\n- options with prices, then a poll\n- budgets from your last few months of spending (private unless you share yours)\n- places to stay, a trip fund you pay into on paydays, splitting expenses, settling up\ntry "${n} summarize", "what's our budget", "i paid 64 for dinner" or "settle up". "${n} stay quiet" if i'm too chatty`,
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

interface Extracted {
  tensions: Tension[];
  newConstraints: boolean;
  /** Messages a fact was taken from (for the 👍 when Atlas doesn't answer). */
  factMessageIds: number[];
}

async function runExtraction(tc: TurnCtx, llm: Llm, cfg: Config, agentName: string): Promise<Extracted> {
  // Everything not yet read: this batch plus anything a failed earlier extraction left behind.
  const since = new Date(tc.now.getTime() - 6 * 3_600_000);
  const recent = await q<MessageRow>(
    `SELECT * FROM messages WHERE chat_id = $1 AND direction = 'inbound' AND kind = 'text' AND extracted_at IS NULL
       AND sent_at > $2 ORDER BY sent_at, id LIMIT 30`,
    [tc.chat.id, since],
  );
  // Sweep: anything older a failed or skipped extraction left behind (a home city in message 1
  // must not be lost), oldest first, in whatever room the batch leaves.
  const older =
    recent.length < 30
      ? await q<MessageRow>(
          `SELECT * FROM messages WHERE chat_id = $1 AND direction = 'inbound' AND kind = 'text' AND extracted_at IS NULL
             AND sent_at <= $2 AND sent_at > $3 ORDER BY sent_at, id LIMIT $4`,
          [tc.chat.id, since, new Date(tc.now.getTime() - 14 * 86_400_000), 30 - recent.length],
        )
      : [];
  const pending = [...older, ...recent];
  if (pending.length === 0) return { tensions: [], newConstraints: false, factMessageIds: [] };
  if (pending.every((m) => isSmallTalk(m.text))) {
    await markExtracted(pending.map((m) => m.id), tc.now);
    return { tensions: [], newConstraints: false, factMessageIds: [] };
  }
  const firstId = pending[0]!.id;
  const context = tc.history.filter((h) => h.id < firstId).slice(-12);
  const profiles = await profilesFor(tc.members.map((m) => m.id), { chatId: tc.chat.id, tripId: tc.trip.id });
  const known = new Map<number, KnownSoFar>(
    [...profiles].map(([id, p]) => [id, { earliest: p.earliest?.value ?? null, latest: p.latest?.value ?? null, city: p.homeCity?.value ?? null }]),
  );
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
    known,
  });
  if (!result.failed) await markExtracted(pending.map((m) => m.id), tc.now);
  const counted = result.factIds.length
    ? await one<{ n: number; sources: number[] | null }>(
        `SELECT count(*) FILTER (WHERE polarity = 'negative' OR key IN ('dietary','travel_limit','date_window','blackout'))::int AS n,
                array_agg(DISTINCT source_message_id) FILTER (WHERE source_message_id IS NOT NULL) AS sources
           FROM facts WHERE id = ANY($1)`,
        [result.factIds],
      )
    : undefined;
  return { tensions: result.tensions, newConstraints: (counted?.n ?? 0) > 0, factMessageIds: (counted?.sources ?? []).map(Number) };
}

/** The promise's value, or undefined if it isn't settled within ms. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A post that waits on someone's answer: a question, or "reply yes"/"say confirm". */
export function asksForAnswer(text: string): boolean {
  return /\?\s*$/.test(text.trim()) || /\b(?:reply|say|type|text)\s+"?(?:yes|no|confirm|ok)\b/i.test(text);
}

const STOP = new Set("a an the and or but so to of in on for at by with is are was be it its this that you your we our us i me my just now then up so can will would should do does did have has had from as if not no yes ok".split(" "));
const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));

/** True when text says nearly the same thing as one of Atlas's last few messages (content-word overlap). */
export function repeatsRecent(text: string, history: Pick<MessageRow, "direction" | "text">[], windowSize = REPEAT_WINDOW_MESSAGES): boolean {
  const mine = words(text);
  if (mine.size < 5) return false;
  const recent = history.filter((h) => h.direction === "outbound" && h.text).slice(-windowSize);
  return recent.some((h) => {
    const theirs = words(h.text);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared += 1;
    return shared / Math.min(mine.size, theirs.size || 1) >= 0.7 && shared >= 3;
  });
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

/** Something the group sees as Atlas talking (a tapback doesn't count). */
const visible = (a: Action) => a.type !== "react";

/**
 * The messages worth a 👍 when Atlas stays silent: ones that gave it something (extraction took a
 * fact from them: dates, a city, what they like to eat). Banter that merely follows an Atlas
 * question doesn't count. Waits a while for extraction when it hasn't landed yet.
 */
async function ackable(remaining: MessageRow[], settled: { factMessageIds: number[] } | undefined, extraction: Promise<{ factMessageIds: number[] }>): Promise<MessageRow[]> {
  const facts = settled ?? (await within(extraction, ACK_EXTRACTION_WAIT_MS));
  const withFacts = new Set(facts?.factMessageIds ?? []);
  return remaining.filter((m) => withFacts.has(m.id));
}

/**
 * 👍 on messages Atlas read but isn't answering, when the turn says nothing else: the latest one
 * per person, at most MAX_ACKS_PER_TURN, never small talk, never twice on one message. Platforms
 * without tapbacks skip it (no fallback text: a "got it" bubble would be the noise it avoids).
 */
export function acknowledge(actions: Action[], candidates: Pick<MessageRow, "id" | "person_id" | "provider_message_id" | "text" | "kind" | "direction">[]): void {
  if (actions.some(visible)) return;
  const reacted = new Set(actions.flatMap((a) => (a.type === "react" ? [a.targetId] : [])));
  const latest = new Map<number, (typeof candidates)[number]>();
  for (const m of candidates) {
    if (m.kind !== "text" || m.direction !== "inbound" || m.person_id === null || !m.provider_message_id || isSmallTalk(m.text)) continue;
    latest.set(m.person_id, m);
  }
  for (const m of [...latest.values()].slice(-MAX_ACKS_PER_TURN)) {
    if (reacted.has(m.provider_message_id)) continue;
    actions.push({ type: "react", targetId: m.provider_message_id, tapback: "like" });
  }
}
