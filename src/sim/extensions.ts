// Simulator-only steps that features add (weather injection, Nessie outage drills, ...).
import type { ScenarioRunner } from "./script.ts";
import type { SimSession } from "./session.ts";
import { weatherSimExtension } from "./weatherExtension.ts";

export type Extension = (args: string, runner: ScenarioRunner) => Promise<void>;

const registry: ((session: SimSession) => Record<string, Extension>)[] = [];
registerSimExtension(weatherSimExtension);

export function registerSimExtension(factory: (session: SimSession) => Record<string, Extension>): void {
  registry.push(factory);
}

export function simExtensions(session: SimSession): Record<string, Extension> {
  return Object.assign({}, ...registry.map((f) => f(session)));
}
