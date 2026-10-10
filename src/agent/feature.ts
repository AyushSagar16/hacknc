// A feature plugs a capability into the turn: deterministic fast paths and commands that run
// before any model, hints for the speak gate, sections of the agent's situation, figures for the
// money guard, and tools. The brain composes features; each phase of the build adds one.
import type { MessageRow } from "../db/repos/core.ts";
import type { GroupView } from "../profile/groupView.ts";
import type { PersonProfile } from "../profile/aggregate.ts";
import type { Command } from "./commands.ts";
import type { Figure } from "./figures.ts";
import type { Tool, ToolCtx } from "./tools.ts";
import type { Config } from "../config.ts";
import type { Llm } from "./llm.ts";
import type { Action } from "../transport/outbound.ts";
import type { JobHandler } from "../pipeline/jobs.ts";
import type { TripRow } from "../trips/state.ts";

/** What background jobs get: a way to post into a chat, the model, config. */
export interface AppServices {
  cfg: Config;
  llm: Llm;
  /** Queue actions for a chat and send them now (guidPrefix must be unique per producer, e.g. "job42"). */
  post(chatId: number, guidPrefix: string, actions: Action[]): Promise<void>;
  /** Run a normal turn for a chat soon (e.g. after a background job changed state). */
  poke(chatId: number): Promise<void>;
}

export interface TurnCtx extends ToolCtx {
  batch: MessageRow[];
  history: MessageRow[];
  profiles(): Promise<Map<number, PersonProfile>>;
  view(): Promise<GroupView>;
  /** Set when a message in the batch was handled deterministically (no model needed for it). */
  consumed: Set<number>;
  /** All features (to fire lifecycle hooks like onTripLocked). */
  features: Feature[];
}

/** Call every feature's onTripLocked hook; failures are logged by the caller's job/turn, never thrown. */
export async function fireTripLocked(trip: TripRow, tc: TurnCtx): Promise<void> {
  for (const f of tc.features) if (f.onTripLocked) await f.onTripLocked(trip, tc).catch(() => {});
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
  /** Background job handlers this feature owns, keyed by job kind. */
  jobs?(svc: AppServices): Record<string, JobHandler>;
  /** After every turn (e.g. queue memory embedding). Must not throw. */
  afterTurn?(tc: TurnCtx): Promise<void>;
  /** When a destination and dates are locked in (e.g. start weather watch, payment plan). */
  onTripLocked?(trip: TripRow, tc: TurnCtx): Promise<void>;
  /** A new person was seen in a chat (e.g. link a Nessie sandbox customer). */
  onNewMember?(chatId: number, personId: number, svc: AppServices): Promise<void>;
}
