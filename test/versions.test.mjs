import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Config is read on import, so the data folder has to be set first. FFmpeg comes from the
// developer's own Trialpilot folder when there is one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trialpilot-test-"));
process.env.TRIALPILOT_DATA_DIR = dataDir;
const ownFfmpeg = path.join(os.homedir(), "Trialpilot", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
if (!process.env.TRIALPILOT_FFMPEG_PATH && fs.existsSync(ownFfmpeg)) process.env.TRIALPILOT_FFMPEG_PATH = ownFfmpeg;

const { buildCommand, checkOutput, describeSpec, makeVersions, outputSize, stripTimes, validateSpec, VersionError } = await import("../dist/video/versions.js");
const { probe, resolveFfmpeg } = await import("../dist/ffmpeg.js");
const { resolveBrowser } = await import("../dist/browser.js");

const tools = resolveFfmpeg();
const canRender = tools && resolveBrowser() ? false : "needs FFmpeg and Chrome or Chromium";

const info = { duration: 10, width: 1080, height: 1920, fps: 30, video_codec: "h264", pix_fmt: "yuv420p", has_audio: true, audio_codec: "aac", size_bytes: 1 };
const io = { input: "in.mp4", output: "out.mp4" };
const graphOf = (plan) => plan.args[plan.args.indexOf("-filter_complex") + 1];

test("output fits 1080×1920 and keeps the source's shape", () => {
  assert.deepEqual(outputSize(2160, 3840), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(720, 1280), { width: 720, height: 1280 });
  assert.deepEqual(outputSize(1920, 1080), { width: 1080, height: 606 });
  assert.deepEqual(outputSize(721, 1281), { width: 720, height: 1280 });
});

test("speed changes picture and sound together, keeping pitch", () => {
  const plan = buildCommand({ speed: 1.05 }, info, io);
  assert.match(graphOf(plan), /setpts=PTS\/1\.05/);
  assert.match(graphOf(plan), /atempo=1\.05/);
  assert.equal(Math.round(plan.duration * 100) / 100, 9.52);
});

test("zoom keeps the top of the frame in place", () => {
  assert.match(graphOf(buildCommand({ zoom: 1.04 }, info, io)), /crop=w=trunc\(iw\/1\.04\/2\)\*2:h=trunc\(ih\/1\.04\/2\)\*2:x=\(iw-ow\)\/2:y=0/);
});

test("the hook is drawn after mirroring and speed, for its seconds only", () => {
  const plan = buildCommand({ hook: { text: "Wait for it", seconds: 3 }, mirror: true, speed: 1.1 }, info, { ...io, hookImage: "hook.png" });
  const graph = graphOf(plan);
  assert.ok(graph.indexOf("hflip") < graph.indexOf("overlay"));
  assert.ok(graph.indexOf("setpts=PTS/1.1") < graph.indexOf("overlay"));
  assert.match(graph, /overlay=0:0:shortest=1:enable='lt\(t,3\)'/);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("-loop"), plan.args.indexOf("-loop") + 6), ["-loop", "1", "-framerate", "30", "-i", "hook.png"]);
});

test("a later start seeks the source; a moved moment is cut and joined", () => {
  const later = buildCommand({ start_at: 2.5 }, info, io);
  assert.deepEqual(later.args.slice(later.args.indexOf("-ss"), later.args.indexOf("-ss") + 4), ["-ss", "2.5", "-i", "in.mp4"]);
  assert.equal(later.duration, 7.5);
  const moved = graphOf(buildCommand({ front_clip: { from: 6, to: 8 } }, info, io));
  assert.match(moved, /\[vs0\]trim=start=6:end=8/);
  assert.match(moved, /\[vs1\]trim=start=0:end=6/);
  assert.match(moved, /\[vs2\]trim=start=8,/);
  assert.match(moved, /concat=n=3:v=1:a=1/);
});

test("sound: silent sources stay silent, a track is mixed in, and metadata is dropped", () => {
  const silent = buildCommand({}, { ...info, has_audio: false }, io);
  assert.ok(silent.args.includes("-an"));
  assert.equal(silent.has_audio, false);
  const mixed = buildCommand({ audio: { track: "song.m4a", track_volume: 0.8, original_volume: 0.3 } }, info, io);
  assert.match(graphOf(mixed), /volume=0\.3\[aorig\]/);
  assert.match(graphOf(mixed), /\[1:a\]atrim=end=10,asetpts=PTS-STARTPTS,volume=0\.8\[atrack\]/);
  assert.match(graphOf(mixed), /amix=inputs=2:duration=first:normalize=0/);
  assert.ok(mixed.args.includes("-map_metadata"));
});

test("asks that are out of range are refused in plain words", () => {
  const refuse = (spec, pattern) => assert.throws(() => validateSpec(spec, info, "Version 1"), (e) => e instanceof VersionError && pattern.test(e.message));
  refuse({ speed: 1.2 }, /speed has to be between 0\.9 and 1\.1/);
  refuse({ zoom: 1.1 }, /at most 5%/);
  refuse({ start_at: 8 }, /at least 3 seconds/);
  refuse({ front_clip: { from: 0, to: 2 } }, /already at the front/);
  refuse({ start_at: 1, front_clip: { from: 2, to: 3 } }, /not both/);
  refuse({ hook: { text: "  " } }, /empty/);
  refuse({ look: { temperature: 12000 } }, /colour temperature/);
});

test("changes are described in plain words", () => {
  assert.equal(describeSpec({ hook: { text: "Watch this" } }), 'hook "Watch this" (top, box, first 4 s)');
  assert.equal(describeSpec({ speed: 1.05, zoom: 1.03 }), "1.05× speed, 3% zoom, top kept in place");
  assert.equal(describeSpec({ look: { temperature: 5500, vignette: true } }), "warmer colour (5500 K), vignette");
  assert.equal(describeSpec({}), "no changes");
});

test("every strip has six frames, starting in the opening", () => {
  for (const duration of [3, 5.7, 6, 8, 30, 180]) {
    const times = stripTimes(duration);
    assert.equal(times.length, 6);
    assert.ok(times.every((t, i) => t >= 0 && t < duration && (i === 0 || t > times[i - 1])), `${duration} s: ${times}`);
    assert.ok(times[1] <= 1.5);
  }
});

test("checkOutput flags files Instagram would reject", () => {
  const plan = { args: [], duration: 10, width: 1080, height: 1920, has_audio: true };
  assert.deepEqual(checkOutput(info, plan), []);
  assert.match(checkOutput({ ...info, video_codec: "hevc" }, plan).join(), /not H\.264/);
  assert.match(checkOutput({ ...info, duration: 7 }, plan).join(), /7\.0 s long/);
  assert.match(checkOutput({ ...info, width: 2160, height: 3840 }, plan).join(), /bigger than 1080×1920/);
});

// A grey 6-second clip with a tone, and a second tone as a music track.
function makeSource(dir) {
  const source = path.join(dir, "source.mp4");
  const track = path.join(dir, "track.m4a");
  execFileSync(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=540x960:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  execFileSync(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=10", "-c:a", "aac", track]);
  return { source, track };
}

/** How much a region of one frame differs between two videos at the same moment, 0 to 255. */
function regionDifference(a, b, t, crop) {
  const out = execFileSync(tools.ffmpeg, ["-v", "error", "-ss", String(t), "-i", a, "-ss", String(t), "-i", b,
    "-filter_complex", `[0:v][1:v]blend=all_mode=difference,crop=${crop},format=gray,scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  return out[0];
}

/** Average of a region of one frame, per channel. */
function regionColour(video, t, crop) {
  const out = execFileSync(tools.ffmpeg, ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-vf", `crop=${crop},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...out];
}

test("renders versions that Instagram accepts, with a strip of frames each", { skip: canRender }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trialpilot-media-"));
  const { source, track } = makeSource(dir);
  const set = await makeVersions(source, [
    { hook: { text: "Wait for the end 👀", position: "top", style: "box" } },
    { speed: 1.1, zoom: 1.04 },
    { look: { contrast: 1.1, temperature: 5000, grain: 8, vignette: true } },
    { front_clip: { from: 3, to: 4.5 } },
    { start_at: 2, audio: { track, track_volume: 0.8, original_volume: 0.3 } },
  ], { preset: "ultrafast" });

  assert.equal(set.versions.length, 5);
  assert.ok(fs.existsSync(path.join(set.folder, "set.json")));
  assert.ok(fs.existsSync(set.original_strip));
  const expected = [6, 5.45, 6, 6, 4];
  for (const [i, version] of set.versions.entries()) {
    const out = await probe(tools, version.file);
    assert.equal(out.video_codec, "h264");
    assert.equal(out.audio_codec, "aac");
    assert.deepEqual([out.width, out.height], [540, 960]);
    assert.ok(Math.abs(out.duration - expected[i]) < 0.25, `${version.id} is ${out.duration} s`);
    assert.ok(fs.statSync(version.strip).size > 1000);
  }

  // The hook box sits near the top for the first 4 seconds, then the plain grey shows through again.
  const insideBox = "270:35:130:140";
  const during = regionDifference(set.versions[0].file, source, 1, insideBox);
  const after = regionDifference(set.versions[0].file, source, 5, insideBox);
  assert.ok(during > 60, `hook shows at 1 s (difference ${during})`);
  assert.ok(after < 10, `hook is gone at 5 s (difference ${after})`);

  // Below 6500 K is warmer: more red than blue.
  const [red, , blue] = regionColour(set.versions[2].file, 2, "40:40:250:460");
  assert.ok(red > blue, `warmer colour: red ${red}, blue ${blue}`);
});

test("refuses a version that repeats an earlier one", { skip: canRender }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trialpilot-media-"));
  const { source } = makeSource(dir);
  await assert.rejects(makeVersions(source, [{ speed: 1.05 }, { speed: 1.05 }], { preset: "ultrafast" }), /same as an earlier one/);
});
