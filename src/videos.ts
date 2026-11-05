import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paths } from "./config.js";

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".wav"]);

export interface MediaFile {
  name: string;
  path: string;
  type: "video" | "audio";
  size_mb: number;
  modified: string;
}

function mediaType(file: string): MediaFile["type"] | null {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/** The videos and music in the videos folder, newest first. */
export async function listVideos(): Promise<MediaFile[]> {
  const names = await fs.readdir(paths.videos).catch(() => [] as string[]);
  const files = await Promise.all(
    names.map(async (name): Promise<MediaFile | null> => {
      const type = mediaType(name);
      const full = path.join(paths.videos, name);
      const stat = type ? await fs.stat(full).catch(() => null) : null;
      if (!type || !stat?.isFile()) return null;
      return { name, path: full, type, size_mb: Math.round(stat.size / 1e5) / 10, modified: stat.mtime.toISOString() };
    }),
  );
  return files.filter((f): f is MediaFile => !!f).sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Full paths are used as given (~ is the home folder); bare names are looked up in the videos folder. */
export function resolveVideo(file: string): string {
  const expanded = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
  return path.isAbsolute(expanded) ? expanded : path.join(paths.videos, expanded);
}
