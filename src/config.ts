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
  // Where the user can drop the videos and music to make versions from.
  videos: path.join(DATA_DIR, "videos"),
  // FFmpeg downloaded with the user's OK lives here; it's GPL, so it is never bundled with Trialpilot.
  bin: path.join(DATA_DIR, "bin"),
  versions: path.join(DATA_DIR, "versions"),
  locks: path.join(DATA_DIR, "state", "locks"),
  screenshots: path.join(DATA_DIR, "screenshots"),
};

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const settings = {
  browserPath: envPath("TRIALPILOT_BROWSER_PATH"),
  ffmpegPath: envPath("TRIALPILOT_FFMPEG_PATH"),
  headless: process.env.TRIALPILOT_HEADLESS === "1",
  maxTrialsPerDay: envInt("TRIALPILOT_MAX_TRIALS_PER_DAY", 5),
  // A trial reel this late is held for the user instead of going out at an unexpected time.
  maxLateMinutes: envInt("TRIALPILOT_MAX_LATE_MINUTES", 120),
  // Test-only: "trial", "public", "unknown", "not_eligible", "fail_before" or "fail_after" replaces Instagram.
  fakePoster: process.env.TRIALPILOT_FAKE_POSTER,
  fakeDelayMs: envInt("TRIALPILOT_FAKE_DELAY_MS", 0),
};
