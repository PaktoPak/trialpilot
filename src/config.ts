import os from "node:os";
import path from "node:path";

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  // An empty MCPB user_config field can arrive as "" or as an unexpanded placeholder.
  if (!value || value.includes("${")) return undefined;
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

export const DATA_DIR = envPath("TRIALPILOT_DATA_DIR") ?? path.join(os.homedir(), "Trialpilot");

export const paths = {
  data: DATA_DIR,
  profiles: path.join(DATA_DIR, "profiles"),
  state: path.join(DATA_DIR, "state"),
  // FFmpeg downloaded with the user's OK lives here; it's GPL, so it is never bundled with Trialpilot.
  bin: path.join(DATA_DIR, "bin"),
  versions: path.join(DATA_DIR, "versions"),
  locks: path.join(DATA_DIR, "state", "locks"),
  screenshots: path.join(DATA_DIR, "screenshots"),
};

export const settings = {
  browserPath: envPath("TRIALPILOT_BROWSER_PATH"),
  ffmpegPath: envPath("TRIALPILOT_FFMPEG_PATH"),
  headless: process.env.TRIALPILOT_HEADLESS === "1",
};
