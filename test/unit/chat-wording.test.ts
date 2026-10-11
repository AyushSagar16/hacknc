// The chat never says Nessie, sandbox, demo, synthetic, simulated, fake or test money: Atlas
// presents connected accounts as real ("your capital one"). Nessie is backend only. This scans
// everything the model reads (prompts, tool descriptions) and the string literals in the agent's
// code that become chat messages. Code comments, identifiers and job names may still say Nessie.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Feature } from "../../src/agent/feature.ts";

const ROOT = join(import.meta.dirname, "../..");
const BANNED = /\b(nessie|sandbox|demo|synthetic|simulated|fake money|test money|play money|not real money|nothing real moves)\b/i;

function walk(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
}

/** Source with comments removed, so only code (and its string literals) is left. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** introLines belongs to the onboarding rewrite (workstream B); everything else must be clean. */
function withoutIntroLines(src: string): string {
  return src.replace(/export function introLines[\s\S]*?\n}\n/, "");
}

describe("user-facing wording", () => {
  it("prompts never mention nessie, sandbox, demo or fake money", () => {
    const dir = join(ROOT, "src/agent/prompts");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      lines.forEach((line, i) => expect(line, `${file}:${i + 1}`).not.toMatch(BANNED));
    }
  });

  it("tool descriptions the model sees never mention them either", async () => {
    const dir = join(ROOT, "src/agent/features");
    const features: Feature[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const mod = (await import(join(dir, file))) as Record<string, unknown>;
      for (const v of Object.values(mod)) if (v && typeof v === "object" && "name" in v && ("tools" in v || "commands" in v)) features.push(v as Feature);
    }
    const decls = features.flatMap((f) => (f.tools ?? []).map((t) => t.decl));
    expect(decls.length).toBeGreaterThan(10);
    const strings: { path: string; text: string }[] = [];
    for (const d of decls) walk(d, d.name, strings);
    for (const s of strings) expect(s.text, s.path).not.toMatch(BANNED);
  });

  it("chat strings in the agent code never mention them", () => {
    const files = [
      ...readdirSync(join(ROOT, "src/agent/features")).map((f) => `src/agent/features/${f}`),
      ...readdirSync(join(ROOT, "src/agent")).filter((f) => f.endsWith(".ts")).map((f) => `src/agent/${f}`),
    ].filter((f) => f.endsWith(".ts"));
    const found: string[] = [];
    for (const file of files) {
      const code = withoutIntroLines(stripComments(readFileSync(join(ROOT, file), "utf8")))
        // Operator logs aren't chat: log().warn({...}, "nessie purchase failed").
        .replace(/\blog\(\)\.(?:info|warn|error|debug)\([^;]*;/g, "");
      // String and template literals only; identifiers like nessie_bill_id or sharedNessie are fine.
      const literals = code.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
      for (const lit of literals) {
        if (/^["`][\w./:-]*["`]$/.test(lit)) continue; // imports, keys, job names, sources ("nessie.link", "nessie-cache")
        if (/^`[\w./:-]*\$\{[^}]*\}[\w./:-]*`$/.test(lit)) continue; // `nessie:${id}` source tags, `/bills/${id}`
        if (/\b(SELECT|UPDATE|INSERT|DELETE)\b/.test(lit)) continue; // SQL column names
        if (BANNED.test(lit)) found.push(`${file}: ${lit.slice(0, 120)}`);
      }
    }
    expect(found).toEqual([]);
  });
});
