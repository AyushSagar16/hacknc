// The demo roster (demo/roster.json, git-ignored): who's who by phone, and an optional pinned
// demo persona per person so the rehearsed budgets are predictable. Real phone numbers stay
// local; Nessie only ever sees fictional persona names.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PERSONA_IDS, type PersonaId } from "./nessie/personas.ts";

const rosterSchema = z.array(
  z.object({
    name: z.string().min(1).max(30),
    phone: z.string().regex(/^\+\d{10,15}$/, "phones are E.164, like +19195550123"),
    persona: z.enum(PERSONA_IDS as unknown as [PersonaId, ...PersonaId[]]).optional(),
  }),
);
export type Roster = z.infer<typeof rosterSchema>;

let cached: Roster | undefined;

export function loadRoster(path = "demo/roster.json"): Roster {
  if (cached) return cached;
  try {
    cached = rosterSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`demo/roster.json is invalid: ${(err as Error).message}`);
    cached = [];
  }
  return cached;
}

export function rosterName(handle: string): string | undefined {
  return loadRoster().find((r) => r.phone === handle)?.name;
}

export function rosterPersona(handle: string): PersonaId | undefined {
  return loadRoster().find((r) => r.phone === handle)?.persona;
}
