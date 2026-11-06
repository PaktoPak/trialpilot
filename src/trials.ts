import fs from "node:fs";
import { BrowserBusyError, NoBrowserError } from "./browser.js";
import { settings } from "./config.js";
import { NotEligibleError, PostError, postTrialReel, type TrialOutcome } from "./instagram/post.js";
import { withLock } from "./lock.js";
import { notify } from "./notify.js";
import {
  getAccount,
  getTrials,
  logAction,
  patchAccount,
  patchTrial,
  peekPreview,
  savePreview,
  takePreview,
  updateTrials,
  type Account,
  type TrialPost,
  type TrialPreview,
  type TrialStatus,
} from "./store.js";
import { errorMessage, localTime, log, newId, normalizeUsername, sleep, UserError } from "./util.js";
import { readVersionSet } from "./video/versions.js";

const PREVIEW_TTL_MS = 30 * 60_000;
// hook-tester, which posts trial reels through Instagram's API, sends one every 30 minutes.
export const SPACING = { default: 30, min: 10, max: 24 * 60 };
const RETRY_DELAY_MS = 10 * 60_000;
const BUSY_DELAY_MS = 2 * 60_000;
const MAX_ATTEMPTS = 2;
const CAPTION_MAX = 2200;
const HASHTAGS_MAX = 30;
const COUNTS_TOWARD_LIMIT: TrialStatus[] = ["scheduled", "posting", "posted", "needs_check", "went_public"];

const sameLocalDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

function dailyCount(trials: TrialPost[], username: string, day: string): number {
  return trials.filter((t) => t.type === "post" && t.account === username && COUNTS_TOWARD_LIMIT.includes(t.status) && sameLocalDay(t.run_at, day)).length;
}

/** Problems with putting these times on the account, given the trial reels it already has. */
function dailyLimitProblems(trials: TrialPost[], username: string, times: string[]): string[] {
  const days = [...new Set(times.map((t) => new Date(t).toDateString()))];
  return days.flatMap((day) => {
    const total = dailyCount(trials, username, day) + times.filter((t) => new Date(t).toDateString() === day).length;
    return total > settings.maxTrialsPerDay
      ? [`@${username} would have ${total} trial reels on ${day}, and the daily limit is ${settings.maxTrialsPerDay}. Pick fewer versions, start another day, or space them further apart.`]
      : [];
  });
}

function parseStart(startAt?: string): number | null {
  if (!startAt) return null;
  const time = Date.parse(startAt);
  if (Number.isNaN(time)) throw new UserError(`"${startAt}" isn't a date and time. Use ISO 8601 with a timezone offset, like 2026-11-06T18:00:00+01:00.`);
  if (time < Date.now() - 60_000) throw new UserError(`${localTime(new Date(time).toISOString())} is in the past.`);
  return time;
}

export interface TrialRequest {
  set_id: string;
  username: string;
  versions: Array<{ version: string; caption: string }>;
  start_at?: string;
  spacing_minutes?: number;
}

/** Checks a trial and saves it as a preview for the user to approve. Throws a UserError listing every problem. */
export async function createTrialPreview(request: TrialRequest): Promise<TrialPreview> {
  const problems: string[] = [];
  const label = `@${normalizeUsername(request.username)}`;
  const account = await getAccount(request.username);
  if (!account) problems.push(`${label} isn't connected. Connect it with connect_account.`);
  if (account?.status === "needs_sign_in") problems.push(`${label} has to sign in again first (connect_account with this username).`);
  if (account?.is_private) problems.push(`${label} is private, and trial reels need a public account.`);
  if (account?.trial_stop) problems.push(`Trial posting on ${label} is stopped. ${account.trial_stop.reason}`);

  const set = await readVersionSet(request.set_id);
  if (!set) problems.push(`There's no set with id ${request.set_id}.`);
  else if (set.status !== "ready") problems.push(`Set ${set.id} ${set.status === "rendering" ? "is still rendering" : `couldn't be made: ${set.error}`}.`);

  const spacing = request.spacing_minutes ?? SPACING.default;
  if (!Number.isFinite(spacing) || spacing < SPACING.min || spacing > SPACING.max) {
    problems.push(`Space the versions ${SPACING.min} minutes to ${SPACING.max / 60} hours apart.`);
  }
  let start: number | null = null;
  try {
    start = parseStart(request.start_at);
  } catch (e) {
    problems.push(errorMessage(e));
  }

  const items: TrialPreview["items"] = [];
  for (const entry of request.versions) {
    const version = set?.versions.find((v) => v.id === entry.version);
    if (set?.status === "ready" && !version) problems.push(`Set ${set.id} has no ${entry.version}; it has ${set.versions.map((v) => v.id).join(", ")}.`);
    if (items.some((i) => i.version === entry.version)) problems.push(`${entry.version} is listed twice.`);
    if (entry.caption.length > CAPTION_MAX) problems.push(`${entry.version}: the caption has ${entry.caption.length} characters, and Instagram allows ${CAPTION_MAX}.`);
    const hashtags = entry.caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
    if (hashtags > HASHTAGS_MAX) problems.push(`${entry.version}: the caption has ${hashtags} hashtags, and Instagram allows ${HASHTAGS_MAX}.`);
    if (!version || items.some((i) => i.version === entry.version)) continue;
    if (!fs.existsSync(version.file)) problems.push(`${entry.version}'s file is gone: ${version.file}. Make the versions again.`);
    const runAt = (start ?? Date.now()) + items.length * spacing * 60_000;
    items.push({ version: version.id, file: version.file, changes: version.changes, caption: entry.caption, run_at: new Date(runAt).toISOString() });
  }
  if (account) problems.push(...dailyLimitProblems(await getTrials(), account.username, items.map((i) => i.run_at)));
  if (problems.length || !account || !set) throw new UserError(["This trial can't go out yet:", ...problems.map((p) => `- ${p}`)].join("\n"));

  const now = Date.now();
  const preview: TrialPreview = {
    id: newId("trialpreview"),
    set_id: set.id,
    account: account.username,
    items,
    spacing_minutes: spacing,
    starts_now: start === null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PREVIEW_TTL_MS).toISOString(),
  };
  await savePreview(preview);
  return preview;
}

/**
 * Turns an approved preview into one trial reel per version, all in one batch. A test run takes
 * the first version only, right away, and leaves the preview for the real thing.
 */
export async function trialsFromPreview(previewId: string, type: TrialPost["type"]): Promise<{ batch_id: string; trials: TrialPost[] }> {
  const preview = type === "post" ? await takePreview(previewId) : await peekPreview(previewId);
  if (!preview) throw new UserError("That preview expired or was already used. Run preview_trial again and show the user the new one.");
  const account = await getAccount(preview.account);
  if (!account) throw new UserError(`@${preview.account} is no longer connected.`);
  if (type === "post" && account.trial_stop) throw new UserError(`Trial posting on @${account.username} is stopped. ${account.trial_stop.reason}`);

  const batchId = newId("batch");
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const items = type === "test" ? preview.items.slice(0, 1) : preview.items;
  const created: TrialPost[] = items.map((item, i) => ({
    id: newId(type === "post" ? "trial" : "test"),
    type,
    batch_id: batchId,
    set_id: preview.set_id,
    version: item.version,
    account: preview.account,
    file: item.file,
    caption: item.caption,
    run_at: type === "test" ? stamp : preview.starts_now ? new Date(now + i * preview.spacing_minutes * 60_000).toISOString() : item.run_at,
    status: "scheduled",
    attempts: 0,
    created_at: stamp,
    updated_at: stamp,
  }));
  await updateTrials((trials) => {
    // Checked again under the lock, so two approvals can't both squeeze under the limit.
    const over = type === "post" ? dailyLimitProblems(trials, preview.account, created.map((t) => t.run_at)) : [];
    if (over.length) throw new UserError(over.join("\n"));
    trials.push(...created);
  });
  for (const t of created) {
    await logAction({ action: type === "post" ? "trial_scheduled" : "trial_test", account: t.account, ok: true, detail: `${t.id} ${t.version} for ${t.run_at}` });
  }
  return { batch_id: batchId, trials: created };
}

/** Cancels the batch's trial reels that haven't gone out yet. */
export async function cancelTrials(batchId: string): Promise<TrialPost[]> {
  const cancelled = await updateTrials((trials) => {
    const batch = trials.filter((t) => t.batch_id === batchId);
    if (!batch.length) throw new UserError(`There's no trial batch with id ${batchId}.`);
    const stamp = new Date().toISOString();
    const waiting = batch.filter((t) => t.status === "scheduled");
    for (const t of waiting) Object.assign(t, { status: "cancelled", note: "Cancelled before it went out.", updated_at: stamp });
    return waiting.map((t) => ({ ...t }));
  });
  for (const t of cancelled) await logAction({ action: "trial_cancelled", account: t.account, ok: true, detail: t.id });
  return cancelled;
}

/** Lets trial posting go on after a stop, once the user has checked the reel that caused it. */
export async function resumeTrialPosting(username: string): Promise<Account> {
  const account = await getAccount(username);
  if (!account) throw new UserError(`@${normalizeUsername(username)} isn't connected.`);
  if (!account.trial_stop) throw new UserError(`Trial posting on @${account.username} isn't stopped.`);
  await patchAccount(account.username, { trial_stop: undefined });
  await logAction({ action: "trial_posting_resumed", account: account.username, ok: true, detail: account.trial_stop.reason });
  return { ...account, trial_stop: undefined };
}

/**
 * The one rule that matters most: when a reel goes out as a normal reel, or might have, no other
 * trial reel goes out on that account until the user has looked. The user is told right away.
 */
async function stopTrialPosting(username: string, reason: string, trialId?: string): Promise<void> {
  await patchAccount(username, { trial_stop: { at: new Date().toISOString(), reason, trial_id: trialId } });
  const stamp = new Date().toISOString();
  await updateTrials((trials) => {
    for (const t of trials) {
      if (t.account === username && t.type === "post" && t.status === "scheduled") {
        Object.assign(t, { status: "cancelled", note: `Not posted, because trial posting on @${username} stopped. ${reason}`, updated_at: stamp });
      }
    }
  });
  await logAction({ action: "trial_posting_stopped", account: username, ok: false, detail: reason });
  notify("Trialpilot stopped trial posting", `@${username}: ${reason}`);
  log(`trial posting on @${username} stopped: ${reason}`);
}

let workerBusy = false;
let rerunRequested = false;

/** Posts every trial reel that's due, one after another. The worker lock keeps two processes from posting at once. */
export async function runDueTrials(): Promise<number> {
  if (workerBusy) {
    // A trial approved while a run is finishing would otherwise wait for the next tick.
    rerunRequested = true;
    return 0;
  }
  workerBusy = true;
  let total = 0;
  try {
    do {
      rerunRequested = false;
      const ran = await withLock(
        "worker",
        async () => {
          let count = 0;
          for (let trial = await claimNextDue(); trial; trial = await claimNextDue()) {
            await execute(trial);
            count++;
          }
          return count;
        },
        0,
      );
      total += ran ?? 0;
    } while (rerunRequested);
    return total;
  } finally {
    workerBusy = false;
  }
}

async function claimNextDue(): Promise<TrialPost | null> {
  const interrupted: TrialPost[] = [];
  const missed: TrialPost[] = [];
  const claimed = await updateTrials((trials) => {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    for (const t of trials) {
      // Trials run one at a time under the worker lock, so one still marked posting was cut off by a crash.
      if (t.status === "posting") {
        Object.assign(t, {
          status: t.type === "post" ? "needs_check" : "failed",
          error: { message: "Trialpilot stopped while this was posting. Check the profile and its trial reels before trying again.", step: "interrupted", stage: "after_share" },
          updated_at: stamp,
        });
        interrupted.push({ ...t });
      }
    }
    const due = trials.filter((t) => t.status === "scheduled" && Date.parse(t.run_at) <= now).sort((a, b) => a.run_at.localeCompare(b.run_at));
    for (const t of due) {
      if (t.type === "post" && (now - Date.parse(t.run_at)) / 60_000 > settings.maxLateMinutes) {
        Object.assign(t, { status: "missed", note: "Its time passed while Trialpilot wasn't running.", updated_at: stamp });
        missed.push({ ...t });
        continue;
      }
      Object.assign(t, { status: "posting", attempts: t.attempts + 1, updated_at: stamp });
      return { ...t };
    }
    return null;
  });
  for (const t of interrupted.filter((t) => t.type === "post")) {
    await stopTrialPosting(t.account, `Trialpilot stopped while ${t.version} was posting, so it isn't known whether it went out as a trial reel.`, t.id);
  }
  for (const t of missed) await logAction({ action: "trial_missed", account: t.account, ok: false, detail: t.id });
  return claimed;
}

async function execute(trial: TrialPost): Promise<void> {
  const account = await getAccount(trial.account);
  if (!account) {
    await patchTrial(trial.id, { status: "failed", error: { message: `@${trial.account} is no longer connected.`, step: "start", stage: "before_share" } });
    return;
  }
  if (trial.type === "post" && account.trial_stop) {
    await patchTrial(trial.id, { status: "cancelled", note: `Not posted, because trial posting on @${account.username} is stopped. ${account.trial_stop.reason}` });
    return;
  }
  try {
    const outcome = settings.fakePoster
      ? await fakePost(trial)
      : await postTrialReel({ account, file: trial.file, caption: trial.caption }, { test: trial.type === "test" });
    await recordOutcome(trial, outcome);
  } catch (e) {
    await handleFailure(trial, e);
  }
}

async function recordOutcome(trial: TrialPost, outcome: TrialOutcome): Promise<void> {
  const result = { code: outcome.code, url: outcome.url, screenshot: outcome.screenshot, note: outcome.note, sent: outcome.sent, finished_at: new Date().toISOString() };
  if (outcome.outcome === "test" || outcome.outcome === "trial") {
    await patchTrial(trial.id, { status: outcome.outcome === "test" ? "tested" : "posted", result, error: undefined });
    await logAction({ action: outcome.outcome === "test" ? "trial_test_done" : "trial_posted", account: trial.account, ok: true, detail: outcome.url ?? trial.id });
    return;
  }
  await patchTrial(trial.id, { status: outcome.outcome === "public" ? "went_public" : "needs_check", result });
  const reason =
    outcome.outcome === "public"
      ? `${trial.version} went out as a normal reel, not a trial reel: ${outcome.url}`
      : `Instagram never confirmed that ${trial.version} is a trial reel: ${outcome.url}`;
  await stopTrialPosting(trial.account, reason, trial.id);
}

async function handleFailure(trial: TrialPost, e: unknown): Promise<void> {
  if (e instanceof BrowserBusyError) {
    // The account's window was in use; that isn't the trial's fault, so it doesn't use up an attempt.
    await patchTrial(trial.id, { status: "scheduled", attempts: trial.attempts - 1, run_at: new Date(Date.now() + BUSY_DELAY_MS).toISOString() });
    return;
  }
  if (e instanceof NotEligibleError) {
    await patchTrial(trial.id, { status: "failed", error: { message: e.message, step: "check_eligibility", stage: "before_share" } });
    // The rest of the batch would be refused the same way.
    const stamp = new Date().toISOString();
    await updateTrials((trials) => {
      for (const t of trials) if (t.batch_id === trial.batch_id && t.status === "scheduled") Object.assign(t, { status: "cancelled", note: e.message, updated_at: stamp });
    });
    await logAction({ action: "trial_not_eligible", account: trial.account, ok: false, detail: e.message });
    return;
  }
  const error: NonNullable<TrialPost["error"]> =
    e instanceof PostError ? { message: e.message, step: e.step, stage: e.stage, screenshot: e.screenshot } : { message: errorMessage(e), step: "start", stage: "before_share" };
  const signedOut = /signed out|different Instagram account/i.test(error.message);
  if (signedOut) await patchAccount(trial.account, { status: "needs_sign_in" });
  if (error.stage === "after_share") {
    await patchTrial(trial.id, { status: trial.type === "post" ? "needs_check" : "failed", error });
    if (trial.type === "post") await stopTrialPosting(trial.account, `Something went wrong after ${trial.version}'s Share (${error.message}), so it may be up.`, trial.id);
    return;
  }
  const retry = trial.type === "post" && !signedOut && !(e instanceof NoBrowserError) && trial.attempts < MAX_ATTEMPTS;
  await patchTrial(trial.id, retry ? { status: "scheduled", error, run_at: new Date(Date.now() + RETRY_DELAY_MS).toISOString() } : { status: "failed", error });
  await logAction({
    action: trial.type === "post" ? "trial_failed" : "trial_test_failed",
    account: trial.account,
    ok: false,
    detail: `${error.step}: ${error.message}${retry ? " (will try again in 10 minutes)" : ""}`,
  });
}

// Test-only stand-in for Instagram, selected with TRIALPILOT_FAKE_POSTER.
async function fakePost(trial: TrialPost): Promise<TrialOutcome> {
  if (settings.fakeDelayMs) await sleep(settings.fakeDelayMs);
  const mode = settings.fakePoster;
  if (mode === "not_eligible") throw new NotEligibleError(`Instagram doesn't offer trial reels to @${trial.account} yet. Nothing was posted.`);
  if (mode === "fail_before") throw new PostError("Fake failure before Share.", "fake", "before_share");
  if (mode === "fail_after") throw new PostError("Fake failure after Share.", "fake", "after_share");
  const sent = { graduation_strategy: "manual", clips_share_preview_to_feed: "0" };
  if (trial.type === "test") return { outcome: "test", sent, note: "Fake test run: nothing was posted." };
  const code = `FAKE${trial.id.slice(-4)}`;
  return { outcome: mode === "public" || mode === "unknown" ? mode : "trial", code, url: `https://www.instagram.com/reel/${code}/`, sent };
}
