// Tools are the only way the agent changes anything or gets a number. Each validates its own
// input, does the deterministic work, posts its own messages (with figures registered for the
// money guard), and returns a short result that tells the model what happened and what's next.
import type { Config } from "../config.ts";
import type { ChatRow, MemberRow } from "../db/repos/core.ts";
import type { Action } from "../transport/outbound.ts";
import type { TripRow } from "../trips/state.ts";
import type { Figures } from "./figures.ts";
import type { Llm, ToolDecl } from "./llm.ts";

export class ToolError extends Error {}

export interface ToolCtx {
  cfg: Config;
  llm: Llm;
  chat: ChatRow;
  trip: TripRow;
  turnId: number;
  /** Who sent the message being handled (tools act "as the sender" for money). */
  senderId: number | null;
  /** Provider-independent id of that message (idempotency keys for side effects). */
  sourceMessageId: number | null;
  members: MemberRow[];
  label(personId: number | null): string;
  /** Resolve a first name (or "me") to a member id. */
  resolve(name: string): number | undefined;
  figures: Figures;
  /** Actions tools post, in order. */
  out: Action[];
  now: Date;
  today: string;
  nonCancellable(): Promise<void>;
  /** Free-form per-turn scratch for tools that need to coordinate (e.g. "a poll was just opened"). */
  notes: Map<string, unknown>;
}

export type ToolResult = { ok: true; data?: unknown; posted?: string[]; next?: string } | { ok: false; error: string };

export interface Tool {
  decl: ToolDecl;
  /** Money and Nessie writes: the turn becomes non-cancellable before this tool runs. */
  sideEffects?: boolean;
  /** Its post says everything (a question, a breakdown); the model's own lead-in is dropped. */
  soloPost?: boolean;
  /** Only offered in a private 1:1 chat ("dm") or only in a group; both when unset. */
  scope?: "dm" | "group";
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
}

export function say(ctx: ToolCtx, ...lines: string[]): string[] {
  for (const text of lines) if (text.trim()) ctx.out.push({ type: "say", text });
  return lines;
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
export const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  add(...tools: Tool[]): this {
    for (const t of tools) this.tools.set(t.decl.name, t);
    return this;
  }

  isSolo(name: string): boolean {
    return this.tools.get(name)?.soloPost === true;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  decls(filter?: (t: Tool) => boolean): ToolDecl[] {
    return [...this.tools.values()].filter((t) => !filter || filter(t)).map((t) => t.decl);
  }

  /** The tools offered in this chat (see Tool.scope). */
  declsFor(chat: Pick<ChatRow, "is_group">): ToolDecl[] {
    return this.decls((t) => inScope(t, chat));
  }

  async run(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool ${name}` };
    if (!inScope(tool, ctx.chat)) return { ok: false, error: `${name} only works in ${tool.scope === "dm" ? "a private chat" : "a group chat"}` };
    try {
      if (tool.sideEffects) await ctx.nonCancellable();
      return await tool.run(args ?? {}, ctx);
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message };
      throw err;
    }
  }
}

const inScope = (t: Tool, chat: Pick<ChatRow, "is_group">) => !t.scope || t.scope === (chat.is_group ? "group" : "dm");
