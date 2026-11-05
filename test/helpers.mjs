import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverPath = path.join(root, "dist", "index.js");

// The developer's own Trialpilot FFmpeg, when there is one.
export const ownFfmpeg = path.join(os.homedir(), "Trialpilot", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

export const makeDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "trialpilot-test-"));

/** A grey 6-second clip with a tone, and a second tone as a music track. */
export function makeSource(ffmpeg, dir, name = "source.mp4") {
  const source = path.join(dir, name);
  const track = path.join(dir, "track.m4a");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=540x960:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=10", "-c:a", "aac", track]);
  return { source, track };
}

export function seedAccounts(dataDir, usernames) {
  const now = new Date().toISOString();
  const accounts = usernames.map((username, i) => ({
    username,
    user_id: String(1000 + i),
    account_type: "business",
    is_private: false,
    profile_dir: path.join(dataDir, "profiles", `acct_${username}`),
    status: "connected",
    connected_at: now,
  }));
  fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "state", "accounts.json"), JSON.stringify(accounts, null, 2));
}

export async function startClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "trialpilot-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** A tool's text and images. Arguments the tool's schema rejects come back as an error too. */
export async function call(client, name, args = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: !!result.isError, content: result.content };
  } catch (e) {
    return { text: e.message, isError: true, content: [] };
  }
}

export const idFrom = (text, prefix) => text.match(new RegExp(`\\b(${prefix}_[0-9a-f]{8})\\b`))?.[1];
