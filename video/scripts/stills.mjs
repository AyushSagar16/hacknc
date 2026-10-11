// Renders a handful of frames as PNGs for a quick visual check:
//   node scripts/stills.mjs AtlasLaunch 0 120 400 ...   →  out/stills/<comp>-<frame>.png
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";

const [id = "AtlasLaunch", ...frames] = process.argv.slice(2);
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id });
for (const f of frames.map(Number)) {
  const output = path.resolve(
    `out/stills/${id}-${String(f).padStart(4, "0")}.png`,
  );
  await renderStill({ serveUrl, composition, frame: f, output, scale: 0.5 });
  console.log(output);
}
