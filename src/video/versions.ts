import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.js";
import { hasAudioTrack, probe, requireFfmpeg, runTool, type FfmpegTools, type VideoInfo } from "../ffmpeg.js";
import { ensureDir, mapLimit, newId, writeJsonAtomic } from "../util.js";
import { renderHookImages, type HookImage, type HookPosition, type HookStyle } from "./hook.js";

/** A problem with what was asked for, worded for the user. */
export class VersionError extends Error {}

/**
 * One edited version of the source video. Each version should change one thing compared with the
 * original, so the trial results show which change worked.
 */
export interface VersionSpec {
  /** A new opening line over the first seconds. */
  hook?: { text: string; position?: HookPosition; style?: HookStyle; seconds?: number };
  /** Opening: start this many seconds in. */
  start_at?: number;
  /** Opening: this moment is moved to the front, and the rest plays in order after it. */
  front_clip?: { from: number; to: number };
  /** Motion: playback speed. Audio keeps its pitch. */
  speed?: number;
  /** Motion: zoom in, keeping the top of the frame in place. */
  zoom?: number;
  look?: { contrast?: number; temperature?: number; grain?: number; vignette?: boolean };
  /** Flips the picture left to right, text and logos included. */
  mirror?: boolean;
  /** Another track mixed in, and the volume of each (1 is unchanged, 0 is off). */
  audio?: { track?: string; track_volume?: number; original_volume?: number };
}

export const LIMITS = {
  versions: 5,
  hookSeconds: [2, 6] as const,
  speed: [0.9, 1.1] as const,
  zoom: [1, 1.05] as const,
  contrast: [0.85, 1.2] as const,
  temperature: [4000, 9000] as const,
  grain: [0, 20] as const,
  volume: [0, 2] as const,
  minSeconds: 3,
  // Reels can be up to 3 minutes long.
  maxSeconds: 180,
  // Larger uploads fail on Instagram.
  maxWidth: 1080,
  maxHeight: 1920,
};

const DEFAULT_HOOK_SECONDS = 4;
const NEUTRAL_TEMPERATURE = 6500;

const n = (x: number) => String(Math.round(x * 1000) / 1000);
const even = (x: number) => Math.max(2, Math.floor(x / 2) * 2);
const within = (v: number | undefined, [lo, hi]: readonly [number, number]) => v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new VersionError(message);
}

/** The frame size of every version: the source's, shrunk to fit 1080×1920 if bigger. */
export function outputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LIMITS.maxWidth / width, LIMITS.maxHeight / height);
  return { width: even(width * scale), height: even(height * scale) };
}

export function expectedDuration(spec: VersionSpec, info: VideoInfo): number {
  return (info.duration - (spec.start_at ?? 0)) / (spec.speed ?? 1);
}

export function validateSpec(spec: VersionSpec, info: VideoInfo, label: string): void {
  const [minSpeed, maxSpeed] = LIMITS.speed;
  check(within(spec.speed, LIMITS.speed), `${label}: speed has to be between ${minSpeed} and ${maxSpeed}.`);
  check(within(spec.zoom, LIMITS.zoom), `${label}: zoom has to be between 1 and ${LIMITS.zoom[1]} (at most 5%).`);
  const look = spec.look ?? {};
  check(within(look.contrast, LIMITS.contrast), `${label}: contrast has to be between ${LIMITS.contrast[0]} and ${LIMITS.contrast[1]}.`);
  check(within(look.temperature, LIMITS.temperature), `${label}: colour temperature has to be between ${LIMITS.temperature[0]} and ${LIMITS.temperature[1]} K.`);
  check(within(look.grain, LIMITS.grain), `${label}: grain has to be between 0 and ${LIMITS.grain[1]}.`);
  check(within(spec.audio?.track_volume, LIMITS.volume) && within(spec.audio?.original_volume, LIMITS.volume), `${label}: volumes have to be between 0 and 2.`);
  if (spec.hook) {
    check(spec.hook.text.trim().length > 0, `${label}: the hook text is empty.`);
    check(spec.hook.text.length <= 120, `${label}: keep the hook under 120 characters, so it can be read in a few seconds.`);
    check(within(spec.hook.seconds, LIMITS.hookSeconds), `${label}: the hook can show for ${LIMITS.hookSeconds[0]} to ${LIMITS.hookSeconds[1]} seconds.`);
  }
  check(!(spec.start_at && spec.front_clip), `${label}: change the opening with start_at or with front_clip, not both.`);
  if (spec.start_at !== undefined) {
    check(spec.start_at >= 0 && info.duration - spec.start_at >= LIMITS.minSeconds, `${label}: start_at has to leave at least ${LIMITS.minSeconds} seconds of video.`);
  }
  if (spec.front_clip) {
    const { from, to } = spec.front_clip;
    check(from > 0, `${label}: front_clip has to start after 0 seconds; a moment at 0 is already at the front.`);
    check(to > from && to <= info.duration, `${label}: front_clip has to end after it starts and within the video (${n(info.duration)} s).`);
  }
  const length = expectedDuration(spec, info);
  check(length >= LIMITS.minSeconds && length <= LIMITS.maxSeconds, `${label}: it would be ${n(length)} s long; reels have to be ${LIMITS.minSeconds} s to 3 minutes.`);
}

/** What a version changes, in plain words. */
export function describeSpec(spec: VersionSpec): string {
  const parts: string[] = [];
  if (spec.hook) {
    parts.push(`hook "${spec.hook.text}" (${spec.hook.position ?? "top"}, ${spec.hook.style ?? "box"}, first ${spec.hook.seconds ?? DEFAULT_HOOK_SECONDS} s)`);
  }
  if (spec.start_at) parts.push(`starts ${n(spec.start_at)} s in`);
  if (spec.front_clip) parts.push(`${n(spec.front_clip.from)}–${n(spec.front_clip.to)} s moved to the front`);
  if (spec.speed && spec.speed !== 1) parts.push(`${n(spec.speed)}× speed`);
  if (spec.zoom && spec.zoom > 1) parts.push(`${n((spec.zoom - 1) * 100)}% zoom, top kept in place`);
  const look = spec.look ?? {};
  if (look.contrast !== undefined && look.contrast !== 1) parts.push(`contrast ${n(look.contrast)}`);
  if (look.temperature !== undefined && look.temperature !== NEUTRAL_TEMPERATURE) {
    parts.push(`${look.temperature < NEUTRAL_TEMPERATURE ? "warmer" : "cooler"} colour (${Math.round(look.temperature)} K)`);
  }
  if (look.grain) parts.push(`grain ${n(look.grain)}`);
  if (look.vignette) parts.push("vignette");
  if (spec.mirror) parts.push("mirrored");
  const audio = spec.audio ?? {};
  if (audio.track) parts.push(`track ${path.basename(audio.track)}${audio.track_volume !== undefined && audio.track_volume !== 1 ? ` at ${Math.round(audio.track_volume * 100)}%` : ""}`);
  if (audio.original_volume !== undefined && audio.original_volume !== 1) {
    parts.push(audio.original_volume === 0 ? "original sound off" : `original sound at ${Math.round(audio.original_volume * 100)}%`);
  }
  return parts.length ? parts.join(", ") : "no changes";
}

export interface RenderPlan {
  args: string[];
  duration: number;
  width: number;
  height: number;
  has_audio: boolean;
}

/** The FFmpeg command for one version: H.264/AAC MP4, at most 1080×1920, no metadata from the source. */
export function buildCommand(spec: VersionSpec, info: VideoInfo, io: { input: string; output: string; hookImage?: string; preset?: string }): RenderPlan {
  const { width, height } = outputSize(info.width, info.height);
  const fps = Math.min(60, Math.round(info.fps) || 30);
  const duration = expectedDuration(spec, info);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (spec.start_at) args.push("-ss", n(spec.start_at));
  args.push("-i", io.input);
  let nextInput = 1;
  const hookInput = io.hookImage ? nextInput++ : undefined;
  if (io.hookImage) args.push("-loop", "1", "-framerate", String(fps), "-i", io.hookImage);
  const trackInput = spec.audio?.track ? nextInput++ : undefined;
  if (spec.audio?.track) args.push("-i", spec.audio.track);

  const graph: string[] = [];
  let v = "[0:v]";
  let a: string | null = info.has_audio ? "[0:a]" : null;

  if (spec.front_clip) {
    const { from, to } = spec.front_clip;
    const parts: Array<[number, number | null]> = [[from, to]];
    if (from > 0.05) parts.push([0, from]);
    if (to < info.duration - 0.05) parts.push([to, null]);
    const range = ([start, end]: [number, number | null]) => (end === null ? `start=${n(start)}` : `start=${n(start)}:end=${n(end)}`);
    const labels = (prefix: string) => parts.map((_, i) => `[${prefix}${i}]`).join("");
    graph.push(`${v}split=${parts.length}${labels("vs")}`);
    parts.forEach((p, i) => graph.push(`[vs${i}]trim=${range(p)},setpts=PTS-STARTPTS[vp${i}]`));
    if (a) {
      graph.push(`${a}asplit=${parts.length}${labels("as")}`);
      parts.forEach((p, i) => graph.push(`[as${i}]atrim=${range(p)},asetpts=PTS-STARTPTS[ap${i}]`));
    }
    const pairs = parts.map((_, i) => `[vp${i}]${a ? `[ap${i}]` : ""}`).join("");
    graph.push(`${pairs}concat=n=${parts.length}:v=1:a=${a ? 1 : 0}[vcat]${a ? "[acat]" : ""}`);
    v = "[vcat]";
    if (a) a = "[acat]";
  }

  const chain: string[] = [];
  if (spec.zoom && spec.zoom > 1) chain.push(`crop=w=trunc(iw/${n(spec.zoom)}/2)*2:h=trunc(ih/${n(spec.zoom)}/2)*2:x=(iw-ow)/2:y=0`);
  chain.push(`scale=${width}:${height}:flags=lanczos`, "setsar=1");
  const look = spec.look ?? {};
  if (look.contrast !== undefined && look.contrast !== 1) chain.push(`eq=contrast=${n(look.contrast)}`);
  if (look.temperature !== undefined && look.temperature !== NEUTRAL_TEMPERATURE) chain.push(`colortemperature=temperature=${Math.round(look.temperature)}`);
  if (look.grain) chain.push(`noise=alls=${Math.round(look.grain)}:allf=t+u`);
  if (look.vignette) chain.push("vignette=PI/7");
  // Mirroring comes before the hook is drawn, so the hook's text still reads the right way round.
  if (spec.mirror) chain.push("hflip");
  // Speed comes before the hook too, so the hook's seconds are seconds of the finished video.
  if (spec.speed && spec.speed !== 1) chain.push(`setpts=PTS/${n(spec.speed)}`);
  graph.push(`${v}${chain.join(",")}[vbase]`);
  v = "[vbase]";
  if (hookInput !== undefined) {
    graph.push(`${v}[${hookInput}:v]overlay=0:0:shortest=1:enable='lt(t,${n(spec.hook?.seconds ?? DEFAULT_HOOK_SECONDS)})'[vhook]`);
    v = "[vhook]";
  }
  graph.push(`${v}format=yuv420p[vout]`);

  let audioOut: string | null = null;
  const originalVolume = spec.audio?.original_volume ?? 1;
  if (a && originalVolume > 0) {
    const filters = [spec.speed && spec.speed !== 1 ? `atempo=${n(spec.speed)}` : "", originalVolume !== 1 ? `volume=${n(originalVolume)}` : ""].filter(Boolean);
    graph.push(`${a}${filters.length ? filters.join(",") : "anull"}[aorig]`);
    audioOut = "[aorig]";
  }
  if (trackInput !== undefined) {
    const trackVolume = spec.audio?.track_volume ?? 1;
    graph.push(`[${trackInput}:a]atrim=end=${n(duration)},asetpts=PTS-STARTPTS${trackVolume !== 1 ? `,volume=${n(trackVolume)}` : ""}[atrack]`);
    if (audioOut) {
      graph.push(`${audioOut}[atrack]amix=inputs=2:duration=first:normalize=0[amix]`);
      audioOut = "[amix]";
    } else {
      audioOut = "[atrack]";
    }
  }
  if (audioOut) graph.push(`${audioOut}aresample=44100[aout]`);

  args.push("-filter_complex", graph.join(";"), "-map", "[vout]");
  if (audioOut) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-ac", "2");
  else args.push("-an");
  args.push(
    "-c:v", "libx264", "-preset", io.preset ?? "medium", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-fps_mode", "cfr", "-r", String(fps), "-g", String(fps * 2),
    "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart",
    io.output,
  );
  return { args, duration, width, height, has_audio: !!audioOut };
}

/** What's wrong with a rendered version, checked with ffprobe; empty when it's fine to upload. */
export function checkOutput(out: VideoInfo, plan: RenderPlan): string[] {
  const problems: string[] = [];
  if (out.video_codec !== "h264") problems.push(`its video is ${out.video_codec}, not H.264`);
  if (out.pix_fmt !== "yuv420p") problems.push(`its pixel format is ${out.pix_fmt}`);
  if (out.width !== plan.width || out.height !== plan.height) problems.push(`it is ${out.width}×${out.height} instead of ${plan.width}×${plan.height}`);
  if (out.width > LIMITS.maxWidth || out.height > LIMITS.maxHeight) problems.push("it is bigger than 1080×1920");
  if (Math.abs(out.duration - plan.duration) > Math.max(0.5, plan.duration * 0.03)) {
    problems.push(`it is ${out.duration.toFixed(1)} s long instead of about ${plan.duration.toFixed(1)} s`);
  }
  if (plan.has_audio && out.audio_codec !== "aac") problems.push("its sound isn't AAC");
  if (!plan.has_audio && out.has_audio) problems.push("it has sound it shouldn't have");
  return problems;
}

/**
 * Six moments for a strip: three from the opening, where the hook is, then three spread over the
 * rest. Short videos get six evenly spaced ones. Every strip has six frames, so strips line up.
 */
export function stripTimes(duration: number): number[] {
  if (duration < 8) return [0, 1, 2, 3, 4, 5].map((i) => (duration * (i + 0.5)) / 6);
  return [0.5, 1.5, 3, ...[0, 1, 2].map((i) => 5 + (i * (duration - 5.3)) / 2)];
}

/** A row of frames from the video, for reviewing versions side by side. */
export async function makeStrip(tools: FfmpegTools, video: string, duration: number, file: string): Promise<void> {
  const times = stripTimes(duration);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const t of times) args.push("-ss", n(t), "-i", video);
  const scaled = times.map((_, i) => `[${i}:v]scale=-2:360,setsar=1[f${i}]`);
  const joined = `${times.map((_, i) => `[f${i}]`).join("")}hstack=inputs=${times.length}[strip]`;
  args.push("-filter_complex", [...scaled, joined].join(";"), "-map", "[strip]", "-frames:v", "1", "-q:v", "4", file);
  await runTool(tools.ffmpeg, args, 120_000);
}

export interface Version {
  id: string;
  spec: VersionSpec;
  changes: string;
  file: string;
  strip: string;
  duration: number;
  width: number;
  height: number;
  size_mb: number;
}

export interface VersionSet {
  id: string;
  source: string;
  source_info: VideoInfo;
  folder: string;
  original_strip: string;
  created_at: string;
  versions: Version[];
}

const round = (x: number, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Renders each version of the source into its own folder, checks every file, and saves a strip of frames per version. */
export async function makeVersions(source: string, specs: VersionSpec[], opts: { preset?: string; parallel?: number } = {}): Promise<VersionSet> {
  check(specs.length >= 1 && specs.length <= LIMITS.versions, `Make between 1 and ${LIMITS.versions} versions at a time.`);
  const tools = requireFfmpeg();
  const sourcePath = path.resolve(source);
  check(await fs.stat(sourcePath).then((s) => s.isFile(), () => false), `Can't find the video ${source}.`);
  const info = await probe(tools, sourcePath);
  check(info.duration >= LIMITS.minSeconds, `The video is only ${n(info.duration)} s long; reels need at least ${LIMITS.minSeconds} s.`);
  specs.forEach((spec, i) => validateSpec(spec, info, `Version ${i + 1}`));
  const seen = new Set<string>();
  specs.forEach((spec, i) => {
    const key = JSON.stringify(spec);
    check(!seen.has(key), `Version ${i + 1} is the same as an earlier one; Instagram treats identical videos as repeats.`);
    seen.add(key);
  });
  for (const spec of specs) {
    if (!spec.audio?.track) continue;
    const track = spec.audio.track;
    check(await fs.stat(track).then((s) => s.isFile(), () => false), `Can't find the audio track ${track}.`);
    check(await hasAudioTrack(tools, track).catch(() => false), `${path.basename(track)} has no sound FFmpeg can read.`);
  }

  const id = newId("set");
  const folder = path.join(paths.versions, id);
  await ensureDir(folder);
  const size = outputSize(info.width, info.height);
  const hookFile = (i: number) => path.join(folder, `v${i + 1}-hook.png`);
  const hooks: HookImage[] = specs.flatMap((spec, i) =>
    spec.hook ? [{ text: spec.hook.text, style: spec.hook.style ?? "box", position: spec.hook.position ?? "top", ...size, file: hookFile(i) }] : [],
  );
  await renderHookImages(hooks);
  const originalStrip = path.join(folder, "original-strip.jpg");
  await makeStrip(tools, sourcePath, info.duration, originalStrip);

  // libx264 already uses every core, so two at a time is enough.
  const versions = await mapLimit(specs, opts.parallel ?? 2, async (spec, i): Promise<Version> => {
    const vid = `v${i + 1}`;
    const file = path.join(folder, `${vid}.mp4`);
    const plan = buildCommand(spec, info, { input: sourcePath, output: file, hookImage: spec.hook ? hookFile(i) : undefined, preset: opts.preset });
    await runTool(tools.ffmpeg, plan.args);
    const out = await probe(tools, file);
    const problems = checkOutput(out, plan);
    if (problems.length) throw new Error(`${vid} came out wrong: ${problems.join("; ")}.`);
    const strip = path.join(folder, `${vid}-strip.jpg`);
    await makeStrip(tools, file, out.duration, strip);
    return { id: vid, spec, changes: describeSpec(spec), file, strip, duration: round(out.duration), width: out.width, height: out.height, size_mb: round(out.size_bytes / 1e6) };
  });

  const set: VersionSet = { id, source: sourcePath, source_info: info, folder, original_strip: originalStrip, created_at: new Date().toISOString(), versions };
  await writeJsonAtomic(path.join(folder, "set.json"), set);
  return set;
}
