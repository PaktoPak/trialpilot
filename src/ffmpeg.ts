import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { paths, settings } from "./config.js";
import { ensureDir } from "./util.js";

export class NoFfmpegError extends Error {}

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function onPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // Claude Desktop starts extensions without the shell's PATH, so also look where Homebrew puts it.
  if (process.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  return dirs.map((dir) => path.join(dir, exe(name))).find((p) => fs.existsSync(p));
}

/** FFmpeg from the settings, Trialpilot's own folder, or this computer's PATH, in that order. */
export function resolveFfmpeg(): FfmpegTools | null {
  const candidates = [
    settings.ffmpegPath ? { ffmpeg: settings.ffmpegPath, ffprobe: path.join(path.dirname(settings.ffmpegPath), exe("ffprobe")) } : null,
    { ffmpeg: path.join(paths.bin, exe("ffmpeg")), ffprobe: path.join(paths.bin, exe("ffprobe")) },
  ];
  for (const c of candidates) if (c && fs.existsSync(c.ffmpeg) && fs.existsSync(c.ffprobe)) return c;
  const ffmpeg = onPath("ffmpeg");
  const ffprobe = onPath("ffprobe");
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
}

export function requireFfmpeg(): FfmpegTools {
  const tools = resolveFfmpeg();
  if (!tools) throw new NoFfmpegError("FFmpeg isn't installed, and making versions needs it. install_ffmpeg can download it once the user says yes.");
  return tools;
}

/** FFmpeg's version line. Throws when it doesn't run, or can't make the H.264 video Instagram needs. */
export async function ffmpegVersion(tools: FfmpegTools): Promise<string> {
  const encoders = await runTool(tools.ffmpeg, ["-hide_banner", "-encoders"], 30_000);
  if (!/\blibx264\b/.test(encoders)) throw new NoFfmpegError(`The FFmpeg at ${tools.ffmpeg} can't make H.264 video (it has no libx264).`);
  await runTool(tools.ffprobe, ["-version"], 30_000);
  return (await runTool(tools.ffmpeg, ["-version"], 30_000)).split("\n")[0].trim();
}

export interface FfmpegDownload {
  site: string;
  /** About how much is downloaded. */
  size_mb: number;
  /** Zip files that hold ffmpeg and ffprobe between them, each with a .sha256 file next to it. */
  zips: string[];
}

/** Where this computer's FFmpeg comes from: the latest release, built with libx264. */
export function ffmpegDownload(platform: NodeJS.Platform = process.platform, arch: string = process.arch): FfmpegDownload | null {
  if (platform === "darwin") {
    const base = `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch === "arm64" ? "arm64" : "amd64"}/release`;
    return { site: "ffmpeg.martin-riedl.de", size_mb: 57, zips: [`${base}/ffmpeg.zip`, `${base}/ffprobe.zip`] };
  }
  if (platform === "win32") return { site: "gyan.dev", size_mb: 115, zips: ["https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"] };
  return null;
}

/** Downloads a file and returns the address it came from after redirects. */
async function fetchFile(url: string, file: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), createWriteStream(file));
  return res.url;
}

async function checkSha256(file: string, url: string): Promise<void> {
  const res = await fetch(`${url}.sha256`);
  const expected = res.ok ? (await res.text()).trim().split(/\s+/)[0].toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`couldn't get the checksum of ${path.basename(url)}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`${path.basename(url)} didn't download correctly (its checksum doesn't match)`);
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    const inside = entry.isDirectory() ? await findFile(full, name) : undefined;
    if (inside) return inside;
  }
  return undefined;
}

/** Downloads FFmpeg and ffprobe into Trialpilot's own folder and checks they work. Returns the version. */
export async function installFfmpeg(download: FfmpegDownload | null = ffmpegDownload()): Promise<string> {
  if (!download) throw new NoFfmpegError("Trialpilot can download FFmpeg on a Mac or a Windows PC only.");
  // A download cut off by a restart leaves its folder behind.
  for (const name of await fsp.readdir(paths.bin).catch(() => [] as string[])) {
    if (name.startsWith("download-")) await fsp.rm(path.join(paths.bin, name), { recursive: true, force: true });
  }
  const work = path.join(paths.bin, `download-${process.pid}`);
  await ensureDir(work);
  // Windows' own tar unpacks zip files; another tar earlier on the PATH may not.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  try {
    for (const [i, url] of download.zips.entries()) {
      const zip = path.join(work, `${i}.zip`);
      await checkSha256(zip, await fetchFile(url, zip));
      await runTool(tar, ["-xf", zip, "-C", work], 5 * 60_000);
    }
    const unpacked: Partial<FfmpegTools> = {};
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      const file = await findFile(work, exe(name));
      if (!file) throw new Error(`the download has no ${exe(name)}`);
      if (process.platform !== "win32") await fsp.chmod(file, 0o755);
      unpacked[name] = file;
    }
    const tools = unpacked as FfmpegTools;
    let version: string;
    try {
      version = await ffmpegVersion(tools);
    } catch (e) {
      if (process.platform !== "darwin") throw e;
      // Apple Silicon Macs only run signed programs; a build without a signature gets a local one.
      for (const file of [tools.ffmpeg, tools.ffprobe]) await runTool("codesign", ["--force", "--sign", "-", file], 60_000);
      version = await ffmpegVersion(tools);
    }
    for (const name of ["ffmpeg", "ffprobe"] as const) await fsp.rename(tools[name], path.join(paths.bin, exe(name)));
    return version;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs a command-line tool and returns its output; a failure throws with the end of its error output. */
export function runTool(file: string, args: string[], timeoutMs = 30 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = String(stderr || error.message).trim().split("\n").slice(-6).join("\n");
      reject(new Error(`${path.basename(file)} failed: ${detail}`));
    });
  });
}

export interface VideoInfo {
  /** Seconds. */
  duration: number;
  /** As shown, after any rotation the phone recorded. */
  width: number;
  height: number;
  fps: number;
  video_codec: string;
  pix_fmt?: string;
  has_audio: boolean;
  audio_codec?: string;
  size_bytes: number;
}

const rate = (r?: string): number => {
  const [n, d] = String(r ?? "").split("/").map(Number);
  return n > 0 && d > 0 ? n / d : n > 0 && !d ? n : 0;
};

/** For music files, which have no video track for probe to read. */
export async function hasAudioTrack(tools: FfmpegTools, file: string): Promise<boolean> {
  const out = JSON.parse(await runTool(tools.ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-print_format", "json", file], 60_000));
  return (out.streams ?? []).length > 0;
}

export async function probe(tools: FfmpegTools, file: string): Promise<VideoInfo> {
  const out = JSON.parse(await runTool(tools.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], 60_000));
  const video = out.streams?.find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = out.streams?.find((s: any) => s.codec_type === "audio");
  if (!video) throw new Error(`${path.basename(file)} has no video track.`);
  const rotation = Number(video.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;
  return {
    duration: Number(out.format?.duration ?? video.duration ?? 0),
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate),
    video_codec: video.codec_name,
    pix_fmt: video.pix_fmt,
    has_audio: !!audio,
    audio_codec: audio?.codec_name,
    size_bytes: Number(out.format?.size ?? 0),
  };
}
