// Adapted from ethanyanghq/scout bridge/devchat/script.ts @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: our own runner over the in-process simulator (no shell-out per line); a pinned
// scenario date and clock travel (`today`, `clock +3d`, `jobs`); scripted model answers
// (`~gate`, `~extract`, `~agent call ...`) so scenarios run offline and deterministically;
// bursts (`&`), membership, native poll votes, line capabilities (`caps local`); expectations
// against Postgres (`expect sql ...`) and the trip row instead of a dev HTTP endpoint.
//
// Format, one step per line (# comments):
//   today 2026-10-10 14:00          pin the clock for date-relative facts
//   members maya leo priya          create the group (first)
//   caps local                      a line without polls/tapbacks/threads
//   atlas joins [by maya]
//   maya: text                      (append & for a burst: don't wait)
//   maya reply atlas.last: text     maya react like atlas.last|"words"|m3     maya vote 2|"lisbon"
//   maya leaves | sam joins
//   clock +3d | jobs | wait
//   ~gate SPEAK reason | ~extract [{...}] | ~agent text: words | ~agent call tool {"json":1}
//   expect atlas ~ "words" | !~ "words" | quiet | says 2 | reacted like
//   expect poll ~ "lisbon" | expect thread ~ "words"
//   expect sql SELECT ... = <json> | expect sql SELECT ... ~ "words"
//   expect trip.status = "locked"
import { readFile } from "node:fs/promises";
import { now } from "../clock.ts";
import { parseDuration } from "../clock.ts";
import { q } from "../db/pool.ts";
import { findChat } from "../db/repos/core.ts";
import type { LlmRole } from "../agent/llm.ts";
import { isTapback } from "../transport/tapbacks.ts";
import { LINQ_LIKE, LOCAL_LIKE, simMembers, type SimChat, type SimEntry } from "../transport/sim/platform.ts";
import { parseScripted } from "./scriptedLlm.ts";
import type { SimSession } from "./session.ts";

export interface Step {
  line: number;
  text: string;
}

export interface RunReport {
  ok: boolean;
  steps: number;
  failure?: { line: number; text: string; reason: string };
  transcript: SimEntry[];
}

export type Printer = (entry: SimEntry) => void;

export async function loadScript(path: string): Promise<Step[]> {
  return parseScript(await readFile(path, "utf8"));
}

export function parseScript(source: string): Step[] {
  return source
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((s) => s.text && !s.text.startsWith("#"));
}

export class ScenarioRunner {
  chat: SimChat | undefined;
  private group: SimChat | undefined;
  private last: SimEntry[] = [];

  constructor(
    private readonly session: SimSession,
    private readonly print: Printer = () => {},
    private readonly opts: { live?: boolean; chatId?: string; extensions?: Record<string, (args: string, runner: ScenarioRunner) => Promise<void>> } = {},
  ) {}

  get lastReplies(): SimEntry[] {
    return this.last;
  }

  async run(steps: Step[]): Promise<RunReport> {
    let i = 0;
    for (const step of steps) {
      i += 1;
      try {
        await this.step(step.text);
      } catch (err) {
        return { ok: false, steps: i, failure: { line: step.line, text: step.text, reason: (err as Error).message }, transcript: this.chat?.transcript ?? [] };
      }
    }
    return { ok: true, steps: i, transcript: this.chat?.transcript ?? [] };
  }

  /** Execute one line. Also used by the REPL. */
  async step(text: string): Promise<void> {
    const { session } = this;
    let m: RegExpExecArray | null;

    if ((m = /^today\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?$/.exec(text))) {
      session.clock.set(new Date(`${m[1]}T${(m[2] ?? "15:00").padStart(5, "0")}:00-04:00`));
      return;
    }
    if ((m = /^dm\s+(\w+)$/.exec(text))) {
      // Switch to a private 1:1 chat with that person (same handle as in the group).
      const group = this.need();
      const member = group.member(m[1]!);
      this.group ??= group;
      this.chat = session.world.chat(`dm-${member.name}`, [member], LINQ_LIKE);
      return;
    }
    if (text === "group") {
      if (this.group) this.chat = this.group;
      return;
    }
    if ((m = /^members\s+(.+)$/.exec(text))) {
      const id = this.opts.chatId ?? `chat-${Math.random().toString(36).slice(2, 8)}`;
      this.chat = session.world.chat(id, simMembers(m[1]!.split(/[\s,]+/).filter(Boolean)), LINQ_LIKE);
      return;
    }
    if ((m = /^caps\s+(linq|local)$/.exec(text))) {
      this.need().capabilities = m[1] === "local" ? LOCAL_LIKE : LINQ_LIKE;
      return;
    }
    if ((m = /^~(gate|extract|agent|summary)\s+(.+)$/.exec(text))) {
      if (!this.opts.live) session.llm.push(m[1] as LlmRole, parseScripted(m[1] as LlmRole, m[2]!));
      return;
    }
    if ((m = /^atlas joins(?:\s+by\s+(\w+))?$/.exec(text))) return this.act(() => this.need().addAtlas(m![1]));
    if ((m = /^(\w+) joins$/.exec(text))) return this.act(() => this.need().addMember(m![1]!, `+1555019${String(this.need().members.length + 1).padStart(4, "0")}`));
    if ((m = /^(\w+) leaves$/.exec(text))) return this.act(() => this.need().removeMember(m![1]!));
    if ((m = /^(\w+) reply ([^:]+):\s*(.+)$/.exec(text))) return this.act(() => this.need().reply(m![1]!, unquote(m![2]!), m![3]!));
    if ((m = /^(\w+) (react|unreact) (\w+) (.+)$/.exec(text))) {
      const tapback = m[3]!;
      if (!isTapback(tapback)) throw new Error(`unknown tapback ${tapback}`);
      return this.act(() => this.need().react(m![1]!, unquote(m![4]!), tapback, { remove: m![2] === "unreact" }));
    }
    if ((m = /^(\w+) (vote|unvote) (.+)$/.exec(text))) return this.act(() => this.need().vote(m![1]!, unquote(m![3]!), { remove: m![2] === "unvote" }));
    if ((m = /^clock\s+(\+?\S+)$/.exec(text))) {
      session.clock.advance(parseDuration(m[1]!));
      return this.runJobs();
    }
    if (text === "jobs") return this.runJobs();
    if (text === "wait") {
      await session.world.waitIdle(this.need().id);
      return;
    }
    if ((m = /^expect\s+(.+)$/.exec(text))) return this.expect(m[1]!);
    if ((m = /^(\w+):\s*(.*?)(\s+&)?$/.exec(text))) {
      const burst = Boolean(m[3]);
      const chat = this.need();
      if (burst) {
        const before = chat.lastEntry();
        await chat.say(m[1]!, m[2]!, { wait: false });
        this.print(chat.lastEntry()!);
        this.last = chat.atlasSince(before);
        return;
      }
      return this.act(() => chat.say(m![1]!, m![2]!));
    }
    const ext = this.opts.extensions;
    if (ext) {
      for (const [prefix, fn] of Object.entries(ext)) {
        if (text === prefix || text.startsWith(`${prefix} `)) return fn(text.slice(prefix.length).trim(), this);
      }
    }
    throw new Error(`don't understand "${text}"`);
  }

  need(): SimChat {
    if (!this.chat) throw new Error("start with `members ...`");
    return this.chat;
  }

  private async act(fn: () => Promise<SimEntry[]>): Promise<void> {
    const chat = this.need();
    const before = chat.transcript.length;
    const replies = await fn();
    for (const e of chat.transcript.slice(before)) this.print(e);
    this.last = replies;
  }

  async runJobs(): Promise<void> {
    const chat = this.need();
    const before = chat.transcript.length;
    for (let i = 0; i < 5; i++) {
      const ran = await this.session.app.jobs.runDue();
      await this.session.world.waitIdle(chat.id);
      if (ran === 0) break;
    }
    const added = chat.transcript.slice(before);
    for (const e of added) this.print(e);
    this.last = added.filter((e) => e.from === "atlas");
  }

  private async expect(spec: string): Promise<void> {
    let m: RegExpExecArray | null;
    const replies = this.last;
    const texts = replies.map((r) => r.text);
    const show = () => (texts.length ? texts.map((t) => `  atlas: ${t}`).join("\n") : "  (atlas said nothing)");

    if (spec === "atlas quiet") {
      if (replies.length) throw new Error(`expected silence, got:\n${show()}`);
      return;
    }
    if ((m = /^atlas says (\d+)$/.exec(spec))) {
      if (replies.length !== Number(m[1])) throw new Error(`expected ${m[1]} messages, got ${replies.length}:\n${show()}`);
      return;
    }
    if ((m = /^atlas reacted (\w+)$/.exec(spec))) {
      if (!replies.some((r) => r.kind === "reaction" && r.text.startsWith(m![1]!))) throw new Error(`expected a ${m[1]} tapback, got:\n${show()}`);
      return;
    }
    if ((m = /^atlas (!?~) (.+)$/.exec(spec))) {
      const words = unquote(m[2]!).toLowerCase();
      const hit = texts.some((t) => t.toLowerCase().includes(words));
      if (m[1] === "~" && !hit) throw new Error(`expected atlas to say "${words}", got:\n${show()}`);
      if (m[1] === "!~" && hit) throw new Error(`expected atlas NOT to say "${words}", got:\n${show()}`);
      return;
    }
    if ((m = /^poll ~ (.+)$/.exec(spec))) {
      const words = unquote(m[1]!).toLowerCase();
      const polls = this.need().transcript.filter((e) => e.from === "atlas" && (e.kind === "poll" || /^\d+\. /.test(e.text)));
      if (!polls.some((p) => p.text.toLowerCase().includes(words))) throw new Error(`no poll option mentions "${words}"`);
      return;
    }
    if ((m = /^thread ~ (.+)$/.exec(spec))) {
      const words = unquote(m[1]!).toLowerCase();
      if (!replies.some((r) => r.replyTo && r.text.toLowerCase().includes(words))) throw new Error(`no threaded reply with "${words}":\n${show()}`);
      return;
    }
    if ((m = /^trip\.(\w+) = (.+)$/.exec(spec))) {
      const chat = await findChat("sim", this.need().id);
      const rows = await q<Record<string, unknown>>(`SELECT ${m[1]} AS v FROM trips WHERE chat_id = $1`, [chat?.id ?? -1]);
      const got = JSON.stringify(rows[0]?.v ?? null);
      const want = JSON.stringify(JSON.parse(m[2]!));
      if (got !== want) throw new Error(`trip.${m[1]} is ${got}, expected ${want}`);
      return;
    }
    if ((m = /^sql (.+) (=|~) ((?:\[|\{|").*)$/.exec(spec))) {
      const rows = await q(m[1]!);
      if (m[2] === "=") {
        const got = JSON.stringify(rows);
        const want = JSON.stringify(JSON.parse(m[3]!));
        if (got !== want) throw new Error(`sql returned ${got}, expected ${want}`);
      } else {
        const words = unquote(m[3]!).toLowerCase();
        if (!JSON.stringify(rows).toLowerCase().includes(words)) throw new Error(`sql result has no "${words}": ${JSON.stringify(rows).slice(0, 400)}`);
      }
      return;
    }
    throw new Error(`unknown expectation "${spec}"`);
  }
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");

export function formatEntry(e: SimEntry, color = true): string {
  const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const at = now().toISOString().slice(11, 16);
  if (e.kind === "system") return c(90, `        · ${e.text}`);
  const who = e.from === "atlas" ? c(36, "atlas") : c(33, e.from);
  const thread = e.replyTo ? c(90, ` ↪ ${e.replyTo}`) : "";
  const body = e.text.split("\n").join(`\n${" ".repeat(14)}`);
  return `${c(90, `[${e.id}]`)} ${c(90, at)} ${who}${thread}: ${body}`;
}
