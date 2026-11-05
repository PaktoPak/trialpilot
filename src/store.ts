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

export async function logAction(entry: Omit<Action, "at">): Promise<void> {
  await ensureDir(paths.state);
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  await fs.appendFile(file.actions(), line + "\n");
}
