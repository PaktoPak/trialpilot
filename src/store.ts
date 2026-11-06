import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.js";
import { withLockOrThrow } from "./lock.js";
import { ensureDir, normalizeUsername, readJson, writeJsonAtomic } from "./util.js";

export type AccountType = "personal" | "business" | "creator" | "unknown";

export interface Account {
  username: string;
  user_id: string;
  full_name?: string;
  account_type: AccountType;
  is_private?: boolean;
  profile_dir: string;
  status: "connected" | "needs_sign_in";
  connected_at: string;
  last_checked_at?: string;
  /** Set when a trial reel went out as a normal reel or couldn't be confirmed: no more trial posting until the user clears it. */
  trial_stop?: { at: string; reason: string; trial_id?: string };
}

/** The trial fields in a reel's publish request. */
export interface TrialSetting {
  graduation_strategy?: string;
  clips_share_preview_to_feed?: string;
}

export type TrialStatus ="scheduled" | "posting" | "posted" | "tested" | "failed" | "needs_check" | "went_public" | "missed" | "cancelled";

/** One version going out as a trial reel, or a test run of the steps. */
export interface TrialPost {
  id: string;
  type: "post" | "test";
  /** Trial reels approved together share a batch id. */
  batch_id: string;
  set_id: string;
  version: string;
  account: string;
  file: string;
  caption: string;
  run_at: string;
  status: TrialStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  note?: string;
  result?: { code?: string; url?: string; finished_at: string; screenshot?: string; note?: string; sent?: TrialSetting };
  error?: { message: string; step: string; stage: "before_share" | "after_share"; screenshot?: string };
}

/** What the user is shown and approves: which versions go out on which account, with which captions, when. */
export interface TrialPreview {
  id: string;
  set_id: string;
  account: string;
  items: Array<{ version: string; file: string; changes: string; caption: string; run_at: string }>;
  spacing_minutes: number;
  /** The first one goes out right after the user's yes; the times shift to match. */
  starts_now: boolean;
  created_at: string;
  expires_at: string;
}

export interface Action {
  at: string;
  action: string;
  account?: string;
  ok: boolean;
  detail?: string;
}

const file = {
  accounts: () => path.join(paths.state, "accounts.json"),
  trials: () => path.join(paths.state, "trials.json"),
  previews: () => path.join(paths.state, "trial-previews.json"),
  actions: () => path.join(paths.state, "actions.jsonl"),
};

// One lock covers every state file: writes are small and rare, so contention is not a concern.
function locked<T>(fn: () => Promise<T>): Promise<T> {
  return withLockOrThrow("state", fn);
}

export async function getAccounts(): Promise<Account[]> {
  return readJson<Account[]>(file.accounts(), []);
}

export async function getAccount(username: string): Promise<Account | undefined> {
  const name = normalizeUsername(username);
  return (await getAccounts()).find((a) => a.username === name);
}

export async function upsertAccount(account: Account): Promise<void> {
  await locked(async () => {
    const all = await getAccounts();
    const rest = all.filter((a) => a.user_id !== account.user_id && a.username !== account.username);
    await writeJsonAtomic(file.accounts(), [...rest, account].sort((a, b) => a.username.localeCompare(b.username)));
  });
}

export async function patchAccount(username: string, patch: Partial<Account>): Promise<void> {
  await locked(async () => {
    const all = await getAccounts();
    const name = normalizeUsername(username);
    await writeJsonAtomic(file.accounts(), all.map((a) => (a.username === name ? { ...a, ...patch } : a)));
  });
}

export async function removeAccount(username: string): Promise<void> {
  await locked(async () => {
    const name = normalizeUsername(username);
    await writeJsonAtomic(file.accounts(), (await getAccounts()).filter((a) => a.username !== name));
  });
}

export async function getTrials(): Promise<TrialPost[]> {
  return readJson<TrialPost[]>(file.trials(), []);
}

/** Read-modify-write on the trial list under the state lock. */
export async function updateTrials<T>(fn: (trials: TrialPost[]) => T): Promise<T> {
  return locked(async () => {
    const trials = await getTrials();
    const result = fn(trials);
    await writeJsonAtomic(file.trials(), trials);
    return result;
  });
}

export async function patchTrial(id: string, patch: Partial<TrialPost>): Promise<TrialPost | undefined> {
  return updateTrials((trials) => {
    const trial = trials.find((t) => t.id === id);
    if (trial) Object.assign(trial, patch, { updated_at: new Date().toISOString() });
    return trial ? { ...trial } : undefined;
  });
}

export async function savePreview(preview: TrialPreview): Promise<void> {
  await locked(async () => {
    const now = Date.now();
    const live = (await readJson<TrialPreview[]>(file.previews(), [])).filter((p) => Date.parse(p.expires_at) > now);
    await writeJsonAtomic(file.previews(), [...live, preview]);
  });
}

export async function peekPreview(id: string): Promise<TrialPreview | undefined> {
  const found = (await readJson<TrialPreview[]>(file.previews(), [])).find((p) => p.id === id);
  return found && Date.parse(found.expires_at) > Date.now() ? found : undefined;
}

/** Removes and returns a preview, so each approval is used once. */
export async function takePreview(id: string): Promise<TrialPreview | undefined> {
  return locked(async () => {
    const all = await readJson<TrialPreview[]>(file.previews(), []);
    const found = all.find((p) => p.id === id);
    await writeJsonAtomic(file.previews(), all.filter((p) => p.id !== id));
    return found && Date.parse(found.expires_at) > Date.now() ? found : undefined;
  });
}

export async function logAction(entry: Omit<Action, "at">): Promise<void> {
  await ensureDir(paths.state);
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  await fs.appendFile(file.actions(), line + "\n");
}
