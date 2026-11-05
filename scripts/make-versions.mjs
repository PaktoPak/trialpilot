// Developer tool: makes edited versions of a video from a JSON list of version specs.
//   node scripts/make-versions.mjs <video> <versions.json>
// Each entry is a VersionSpec (see src/video/versions.ts), e.g. [{"hook":{"text":"Wait for it"}},{"speed":1.05}]
import fs from "node:fs";
import { makeVersions } from "../dist/video/versions.js";

const [video, specFile] = process.argv.slice(2);
if (!video || !specFile) {
  console.error("Usage: node scripts/make-versions.mjs <video> <versions.json>");
  process.exit(1);
}
const set = await makeVersions(video, JSON.parse(fs.readFileSync(specFile, "utf8")));
console.log(`${set.id} in ${set.folder}`);
console.log(`original: ${set.source_info.width}×${set.source_info.height}, ${set.source_info.duration.toFixed(1)} s, strip ${set.original_strip}`);
for (const v of set.versions) console.log(`${v.id}: ${v.changes}; ${v.width}×${v.height}, ${v.duration} s, ${v.size_mb} MB, strip ${v.strip}`);
