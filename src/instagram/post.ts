import type { Locator, Page, Request, Route } from "playwright-core";
import { dismissPopups, openProfile, screenshot } from "../browser.js";
import type { Account, TrialSetting } from "../store.js";
import { errorMessage } from "../util.js";
import { advanceToCaption, clickIfVisible, openNewPost, switchRows } from "./composer.js";
import { labels } from "./labels.js";
import { gotoHome, IG, sessionUserId } from "./session.js";
import { watchTrialSignals, type TrialSignals } from "./trial.js";

export type ShareStage = "before_share" | "after_share";

/** stage says whether the reel's publish request went out: after it, the reel may be up, so nothing is retried. */
export class PostError extends Error {
  constructor(message: string, readonly step: string, readonly stage: ShareStage, readonly screenshot?: string) {
    super(message);
  }
}

/** Instagram doesn't offer trial reels to this account. */
export class NotEligibleError extends Error {}

export interface TrialOutcome {
  /**
   * trial: Instagram marks the new reel is_trial_reel and it isn't on the profile grid.
   * public: it went out as a normal reel. unknown: it went out, but neither could be confirmed.
   * test: a test run, whose publish request was stopped, so nothing was posted.
   */
  outcome: "trial" | "public" | "unknown" | "test";
  code?: string;
  url?: string;
  screenshot?: string;
  note?: string;
  /** The trial fields the publish request carried, or would have in a test run. */
  sent?: TrialSetting;
}

type CheckedSetting = TrialSetting & { ok: boolean };

// The fields instagram.com's own composer adds to a reel's publish request when its trial switch is
// on: the reel is shown to non-followers first, and only the user shares it to followers later.
const TRIAL_PARAMS = JSON.stringify({ graduation_strategy: "manual" });
const CONFIGURE = /^\/api\/v1\/media\/configure_to_clips\/?$/;
// Any other request that could publish would go out without the trial fields.
const OTHER_PUBLISH = /configure|publish|create_?(reel|clip|media|post)|share_?(reel|clip|media|post)/i;

// trial_params arrives as a JSON string, as nested form fields, or as an object inside signed_body.
function graduationStrategy(fields: Record<string, unknown>): unknown {
  if (fields["trial_params[graduation_strategy]"] !== undefined) return fields["trial_params[graduation_strategy]"];
  const params = fields.trial_params;
  if (typeof params !== "string") return (params as { graduation_strategy?: unknown } | undefined)?.graduation_strategy;
  try {
    return JSON.parse(params).graduation_strategy;
  } catch {
    return undefined;
  }
}

/** The trial fields of a configure_to_clips body, whichever way it's encoded, and whether they make a trial. */
export function trialFieldsOf(body: string): CheckedSetting {
  const form = new URLSearchParams(body);
  let fields: Record<string, unknown> = Object.fromEntries(form);
  const signed = form.get("signed_body");
  if (signed?.startsWith("SIGNATURE.")) {
    try {
      fields = { ...fields, ...JSON.parse(signed.slice("SIGNATURE.".length)) };
    } catch {
      // not JSON: only the form fields count
    }
  }
  const strategy = graduationStrategy(fields);
  const toFeed = fields.clips_share_preview_to_feed;
  return {
    ...(strategy !== undefined ? { graduation_strategy: String(strategy) } : {}),
    ...(toFeed !== undefined ? { clips_share_preview_to_feed: String(toFeed) } : {}),
    ok: typeof strategy === "string" && strategy.length > 0 && String(toFeed) === "0",
  };
}

/** A configure_to_clips body with the trial fields set, unless the website already set them. */
export function withTrialFields(body: string): string {
  if (trialFieldsOf(body).ok) return body;
  const form = new URLSearchParams(body);
  const signed = form.get("signed_body");
  if (signed?.startsWith("SIGNATURE.")) {
    const data = JSON.parse(signed.slice("SIGNATURE.".length));
    Object.assign(data, { trial_params: TRIAL_PARAMS, clips_share_preview_to_feed: "0" });
    form.set("signed_body", `SIGNATURE.${JSON.stringify(data)}`);
    return form.toString();
  }
  form.set("trial_params", TRIAL_PARAMS);
  form.set("clips_share_preview_to_feed", "0");
  return form.toString();
}

function friendlyName(request: Request): string {
  return request.headers()["x-fb-friendly-name"] ?? new URLSearchParams(request.postData() ?? "").get("fb_api_req_friendly_name") ?? "";
}

export interface Guard {
  test: boolean;
  /** Trial fields of each publish request, as it left or would have left. */
  sent: CheckedSetting[];
  /** Other requests that could publish, which never leave the window. */
  stopped: string[];
  /** In a test run, every other request held back. */
  held: string[];
}

/**
 * Every POST from Share on passes here. The reel's publish request leaves only with its trial
 * fields, and never in a test run; any other request that could publish is dropped. A test run
 * lets nothing out but the video's upload.
 */
export async function guardPublish(route: Route, guard: Guard): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() !== "POST" || !url.hostname.endsWith("instagram.com") || url.pathname.startsWith("/rupload_ig")) return route.fallback();
  if (CONFIGURE.test(url.pathname)) {
    const body = withTrialFields(request.postData() ?? "");
    const fields = trialFieldsOf(body);
    guard.sent.push(fields);
    if (guard.test || !fields.ok) return route.abort();
    return route.continue({ postData: body });
  }
  const name = (/graphql/.test(url.pathname) && friendlyName(request)) || url.pathname;
  if (OTHER_PUBLISH.test(name)) {
    guard.stopped.push(name);
    return route.abort();
  }
  if (guard.test) {
    guard.held.push(name);
    return route.abort();
  }
  return route.fallback();
}

/**
 * Runs Instagram's New post flow on instagram.com for one video, as a trial reel: file, caption
 * (read back), sharing to Facebook and Threads off, the trial switch if the website shows one,
 * then Share with the trial fields checked on the way out, and a look at the new reel afterwards.
 * A test run does everything, Share included, but stops the publish request, so nothing is posted.
 */
export async function postTrialReel(input: { account: Account; file: string; caption: string }, opts: { test: boolean }): Promise<TrialOutcome> {
  const { account } = input;
  const { context, page } = await openProfile(account.profile_dir);
  const dialog = page.locator('div[role="dialog"]');
  const signals = watchTrialSignals(page);
  let step = "open_instagram";
  let published = false;
  const fail = async (message: string) =>
    new PostError(message, step, published ? "after_share" : "before_share", await screenshot(page, `${account.username}-${step}`));
  // Leaving the half-filled New post window asks "Leave site?": leave, and answer nothing else.
  page.on("dialog", (d) => (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {}));

  try {
    await gotoHome(page);
    await dismissPopups(page);

    step = "check_account";
    const userId = await sessionUserId(context);
    if (!userId) throw await fail(`@${account.username} is signed out. Connect it again with connect_account.`);
    if (userId !== account.user_id) throw await fail(`A different Instagram account is signed in to @${account.username}'s window.`);

    step = "open_new_post";
    const fileInput = await openNewPost(page);
    if (!fileInput) throw await fail("Couldn't open Instagram's New post window.");

    step = "add_file";
    await fileInput.setInputFiles([input.file]);
    await page.waitForTimeout(2500);
    // First video upload shows "Video posts are now shared as reels".
    await clickIfVisible(dialog.getByRole("button", { name: labels.ok }).first());

    step = "go_to_caption";
    const captionBox = await advanceToCaption(page);
    if (!captionBox) throw await fail("Couldn't reach the caption step of the New post window.");

    step = "write_caption";
    if (input.caption) {
      const written = await writeCaption(page, captionBox, input.caption);
      // A caption ending in a #hashtag or @mention leaves Instagram's suggestion list open; clicking
      // the window title closes it without touching the text.
      await clickIfVisible(dialog.getByRole("heading").first());
      if (!written || normalized(await captionBox.innerText()) !== normalized(input.caption)) throw await fail("The caption didn't go in exactly as written.");
    }

    step = "share_settings";
    if (!(await turnOffCrossPosting(page))) throw await fail("Couldn't turn off sharing to Facebook or Threads for this reel.");

    step = "trial_switch";
    await clickIfVisible(dialog.getByText(labels.advancedSettings).first());
    const usedSwitch = await turnOnTrialSwitch(page);

    step = "check_eligibility";
    const notEligible = eligibilityProblem(account, signals);
    if (notEligible) throw new NotEligibleError(notEligible);

    step = "share";
    const guard: Guard = { test: opts.test, sent: [], stopped: [], held: [] };
    let configured: any;
    page.on("response", async (response) => {
      if (!CONFIGURE.test(new URL(response.url()).pathname)) return;
      configured = await response.json().catch(() => ({ status: response.status() }));
    });
    await page.route("**/*", (route) => guardPublish(route, guard));
    await dialog.getByRole("button", { name: labels.share }).first().click({ timeout: 10_000 });

    // The video uploads first, so the publish request can take a few minutes to come.
    const deadline = Date.now() + (opts.test ? 5 : 10) * 60_000;
    while (Date.now() < deadline && !guard.sent.length && !guard.stopped.length) await page.waitForTimeout(1000);
    const sent = guard.sent[0];
    if (!sent) {
      const held = guard.held.length ? ` In a test run Trialpilot holds back every other request, and the website sent ${[...new Set(guard.held)].join(", ")}.` : "";
      throw await fail(
        guard.stopped.length
          ? `Instagram tried to publish another way (${guard.stopped[0]}), without the trial setting, so Trialpilot stopped it. Nothing was posted.`
          : `Share was clicked, but the website never sent its publish request. Nothing was posted.${held}`,
      );
    }
    const { ok: hasTrialFields, ...fields } = sent;
    if (!hasTrialFields) throw await fail("The publish request had no trial setting, so Trialpilot stopped it. Nothing was posted.");
    if (opts.test) {
      await page.waitForTimeout(2000);
      return {
        outcome: "test",
        sent: fields,
        screenshot: await screenshot(page, `${account.username}-test-run`),
        note: `Test run: the file, caption and settings were filled in and Share was clicked. The publish request carried the trial setting (${describeFields(fields)}) and was stopped, so nothing was posted.${usedSwitch ? " The website's own trial switch was on." : ""}`,
      };
    }
    published = true;

    step = "wait_for_confirmation";
    const confirmed = await waitForPublished(page, () => configured);
    if (confirmed === "failed") {
      published = false; // Instagram itself said nothing went through
      throw await fail("Instagram said the reel couldn't be shared. Nothing was posted.");
    }
    const code: string | undefined = configured?.media?.code;
    if (!code) throw await fail("Share went through, but Instagram didn't say which reel it made. Check the profile before trying again.");

    step = "confirm_trial";
    return { ...(await confirmTrial(page, account, code, signals)), sent: fields };
  } catch (e) {
    if (e instanceof PostError || e instanceof NotEligibleError) throw e;
    throw await fail(errorMessage(e));
  } finally {
    await context.close().catch(() => {});
  }
}

/** Why the account can't post trial reels, from what the website says about it; null if nothing says it can't. */
function eligibilityProblem(account: Account, signals: TrialSignals): string | null {
  if (signals.is_private ?? account.is_private) return `@${account.username} is private, and trial reels need a public account. Nothing was posted.`;
  if (signals.trial_clips_enabled === false) return `Instagram doesn't offer trial reels to @${account.username} yet. Nothing was posted.`;
  return null;
}

function describeFields(fields: TrialSetting): string {
  return Object.entries(fields).map(([k, v]) => `${k} ${v}`).join(", ");
}

/** Turns on the website's trial switch when it shows one, and reads it back. False when there is none. */
async function turnOnTrialSwitch(page: Page): Promise<boolean> {
  const row = (await switchRows(page)).find((r) => labels.trial.test(r.text.split("\n")[0] ?? ""));
  if (!row) return false;
  if (!(await row.toggle.isChecked())) {
    await row.toggle.click({ force: true });
    await page.waitForTimeout(1200);
  }
  if (!(await row.toggle.isChecked())) throw new Error("Couldn't turn on the website's trial reel switch.");
  return true;
}

/** "done" once Instagram answered the publish request with the new reel, "failed" if it said no. */
async function waitForPublished(page: Page, answer: () => any): Promise<"done" | "failed" | "unknown"> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const reply = answer();
    if (reply?.media?.code) return "done";
    if (reply && (reply.status === "fail" || typeof reply.status === "number")) return "failed";
    const text = (await page.locator('div[role="dialog"]').allInnerTexts().catch(() => [])).join("\n");
    if (labels.shareFailed.test(text)) return "failed";
    await page.waitForTimeout(2000);
  }
  return "unknown";
}

/**
 * A trial reel reads is_trial_reel and stays off the profile grid; a normal reel shows up there. Instagram
 * can take a moment to process a new reel, so it looks a few times.
 */
async function confirmTrial(page: Page, account: Account, code: string, signals: TrialSignals): Promise<TrialOutcome> {
  const url = `${IG}/reel/${code}/`;
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 5000 : 15_000);
    await page.goto(`${url}?hl=en`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const shot = await screenshot(page, `${account.username}-trial-${code}`);
    const onGrid = (await profilePostCodes(page, account.username)).some((c) => c.endsWith(`/${code}`));
    if (onGrid || signals.public_media.includes(code)) {
      return { outcome: "public", code, url, screenshot: shot, note: onGrid ? "It's on the profile grid, so it went out as a normal reel." : "Instagram marks it as a normal reel." };
    }
    if (signals.trial_media.includes(code)) {
      return { outcome: "trial", code, url, screenshot: shot, note: "Instagram marks it as a trial reel, and it isn't on the profile grid." };
    }
  }
  return {
    outcome: "unknown",
    code,
    url,
    screenshot: await screenshot(page, `${account.username}-trial-${code}-unknown`),
    note: "It isn't on the profile grid, but Instagram's pages never said whether it's a trial reel.",
  };
}

const normalized = (s: string) => s.replace(/\s+/g, " ").trim();

/** Pastes the caption (keeps line breaks and emoji), falls back to typing, and reads it back before Share. */
async function writeCaption(page: Page, box: Locator, caption: string): Promise<boolean> {
  await box.click();
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, caption);
  await page.waitForTimeout(800);
  if (normalized(await box.innerText()) === normalized(caption)) return true;

  await box.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  const lines = caption.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }
  await page.waitForTimeout(800);
  return normalized(await box.innerText()) === normalized(caption);
}

/**
 * Instagram remembers "Share to Facebook" and "Share to Threads" between posts. A trial reel goes
 * to Instagram only, so those are switched off and checked to stay off.
 */
async function turnOffCrossPosting(page: Page): Promise<boolean> {
  const crossPost = async () => (await switchRows(page)).filter((r) => /Facebook|Threads/i.test(r.text)).map((r) => r.toggle);
  let toggles = await crossPost();
  if (!toggles.length) {
    // The "Share to" section may be collapsed; open it to see what Instagram remembered.
    await clickIfVisible(page.locator('div[role="dialog"]').getByText(/^(Share to|Condividi su)$/).first());
    toggles = await crossPost();
  }
  for (const toggle of toggles) {
    if (await toggle.isChecked().catch(() => false)) {
      await toggle.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }
    if (await toggle.isChecked().catch(() => false)) return false;
  }
  return true;
}

/** "p/CODE" or "reel/CODE" for each post linked from the account's profile grid. */
async function profilePostCodes(page: Page, username: string): Promise<string[]> {
  await page.goto(`${IG}/${username}/?hl=en`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'))
      .map((a) => (a.getAttribute("href") ?? "").match(/\/(p|reel)\/([A-Za-z0-9_-]+)/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => `${m[1]}/${m[2]}`);
    return Array.from(new Set(codes));
  });
}
