import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths, settings } from "./config.js";

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
  if (!tools) throw new NoFfmpegError("FFmpeg isn't installed. Ask to download it once (about 50 MB), or install it yourself.");
  return tools;
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
