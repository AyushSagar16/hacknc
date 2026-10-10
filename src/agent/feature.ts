// A feature plugs a capability into the turn: deterministic fast paths and commands that run
// before any model, hints for the speak gate, sections of the agent's situation, figures for the
// money guard, and tools. The brain composes features; each phase of the build adds one.
import type { MessageRow } from "../db/repos/core.ts";
import type { GroupView } from "../profile/groupView.ts";
import type { PersonProfile } from "../profile/aggregate.ts";
import type { Command } from "./commands.ts";
import type { Figure } from "./figures.ts";
import type { Tool, ToolCtx } from "./tools.ts";

export interface TurnCtx extends ToolCtx {
  batch: MessageRow[];
  history: MessageRow[];
  profiles(): Promise<Map<number, PersonProfile>>;
  view(): Promise<GroupView>;
  /** Set when a message in the batch was handled deterministically (no model needed for it). */
  consumed: Set<number>;
}

export interface Section {
  title: string;
  lines: string[];
}

export interface Feature {
  name: string;
  tools?: Tool[];
  /** Figures from saved state that the model may quote this turn. */
  figures?(tc: TurnCtx): Promise<Figure[]>;
  /** Handle one inbound message without a model. Return true if fully handled. */
  fastPath?(msg: MessageRow, tc: TurnCtx): Promise<boolean>;
  commands?: Partial<Record<Command["kind"], (msg: MessageRow, tc: TurnCtx, cmd: Command) => Promise<void>>>;
  /** Deterministic reasons the gate should consider speaking (deadline near, decision stuck...). */
  hints?(tc: TurnCtx): Promise<string[]>;
  /** Proactive messages this feature wants to send this turn regardless of the gate (rate-limited by the brain). */
  proactive?(tc: TurnCtx): Promise<boolean>;
  situation?(tc: TurnCtx): Promise<Section | null>;
  summary?(tc: TurnCtx): Promise<string[]>;
  /** A private 1:1 chat with one person. Return true if handled. */
  directMessage?(msg: MessageRow, tc: TurnCtx): Promise<boolean>;
}
