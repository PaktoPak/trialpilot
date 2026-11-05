import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const newId = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (e: any) {
    if (e?.code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  // On Windows a file being scanned or read elsewhere can't be replaced for a moment; try again briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e: any) {
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
      await sleep(50 * (attempt + 1));
    }
  }
}

export const normalizeUsername = (u: string) => u.trim().replace(/^@/, "").toLowerCase();

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// stdout carries the MCP protocol, so all logging goes to stderr.
export function log(...args: unknown[]): void {
  console.error("[trialpilot]", ...args);
}
