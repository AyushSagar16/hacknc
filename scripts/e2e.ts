// Runs every scenario in test/scenarios through the simulator. Scripted model answers by
// default (offline, deterministic); --live uses real Gemini and ignores the scripted lines.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatEntry, loadScript, ScenarioRunner } from "../src/sim/script.ts";
import { startSession } from "../src/sim/session.ts";
import { simExtensions } from "../src/sim/extensions.ts";

const live = process.argv.includes("--live");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dir = join(process.cwd(), "test", "scenarios");
const files = (await readdir(dir)).filter((f) => f.endsWith(".chat") && (only.length === 0 || only.some((o) => f.includes(o)))).sort();

let passed = 0;
const failures: string[] = [];
for (const file of files) {
  const session = await startSession({ llmMode: live ? "live" : "scripted", logFile: join(process.cwd(), ".sim", "e2e.log") });
  const lines: string[] = [];
  const runner = new ScenarioRunner(session, (e) => lines.push(formatEntry(e, false)), { live, extensions: simExtensions(session) });
  const report = await runner.run(await loadScript(join(dir, file)));
  await session.close();
  if (report.ok) {
    passed += 1;
    console.log(`✓ ${file}`);
  } else {
    failures.push(file);
    console.log(`✗ ${file} — line ${report.failure!.line}: ${report.failure!.text}\n  ${report.failure!.reason.split("\n").join("\n  ")}`);
    console.log(lines.slice(-12).map((l) => `    ${l}`).join("\n"));
  }
}
console.log(`\n${passed} of ${files.length} scenarios passed${live ? " (live gemini)" : " (scripted)"}`);
process.exit(failures.length ? 1 : 0);
