// Developer tool: checks what instagram.com offers a connected account for trial reels.
// It reads the Create menu, opens the New post window with a video, reads its switches (turning a
// trial switch on if there is one) and closes before Share, so nothing is posted.
//   node scripts/inspect-trial.mjs <username> <video> [--capture]
// --capture also clicks Share with every publishing request blocked, prints the request the website
// would have sent, and still creates no post. Run it only after the user's yes.
import { dismissPopups, openProfile, screenshot } from "../dist/browser.js";
import { advanceToCaption, clickIfVisible, openNewPost, switchRows } from "../dist/instagram/composer.js";
import { labels } from "../dist/instagram/labels.js";
import { gotoHome, sessionUserId } from "../dist/instagram/session.js";
import { watchTrialSignals } from "../dist/instagram/trial.js";
import { getAccount } from "../dist/store.js";

const args = process.argv.slice(2);
const capture = args.includes("--capture");
const [username, file] = args.filter((a) => !a.startsWith("--"));
const account = username ? await getAccount(username) : undefined;
if (!account || !file) {
  console.error("Usage: node scripts/inspect-trial.mjs <username> <video> [--capture]. Connect the account first with scripts/connect.mjs.");
  process.exit(1);
}

const { context, page } = await openProfile(account.profile_dir);
// Leaving a half-filled New post window asks "Leave site?": leave, and answer nothing else.
page.on("dialog", (d) => (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {}));
const signals = watchTrialSignals(page);
const requests = new Set();
page.on("request", (req) => {
  const url = new URL(req.url());
  if (!url.hostname.endsWith("instagram.com") || !/^\/(api|graphql|ajax)\b/.test(url.pathname)) return;
  const name = req.headers()["x-fb-friendly-name"] ?? req.postData()?.match(/fb_api_req_friendly_name=([^&]+)/)?.[1];
  requests.add(`${req.method()} ${url.pathname}${name ? ` ${name}` : ""}`);
});

// Publishing requests never leave this window, in either mode: they are recorded and dropped.
const blocked = [];
const drop = async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  blocked.push({ method: req.method(), path: url.pathname, body: decodeBody(req.postData()) });
  await route.abort();
};
await page.route(/instagram\.com\/api\/v1\/.*(configure|publish)/, drop);

const report = { account: account.username, capture };
try {
  await gotoHome(page);
  await dismissPopups(page);
  if ((await sessionUserId(context)) !== account.user_id) throw new Error(`@${account.username}'s window isn't signed in to that account.`);

  report.create_menu = await readCreateMenu();
  report.create_menu_screenshot = await screenshot(page, `${account.username}-create-menu`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);

  const input = await openNewPost(page);
  if (!input) throw new Error("Couldn't open the New post window.");
  await input.setInputFiles([file]);
  await page.waitForTimeout(3000);
  // First video upload shows "Video posts are now shared as reels".
  await clickIfVisible(page.locator('div[role="dialog"]').getByRole("button", { name: labels.ok }).first());
  if (!(await advanceToCaption(page))) throw new Error("Couldn't reach the caption step of the New post window.");
  await page.waitForTimeout(3000);
  await clickIfVisible(page.locator('div[role="dialog"]').getByText(labels.advancedSettings).first());
  report.caption_step_text = await dialogText();
  report.switches = await Promise.all((await switchRows(page)).map(async (r) => ({ label: r.text.split("\n")[0], on: await r.toggle.isChecked() })));

  const trialRow = (await switchRows(page)).find((r) => labels.trial.test(r.text));
  report.trial_switch = trialRow ? { label: trialRow.text.split("\n")[0], on_before: await trialRow.toggle.isChecked() } : null;
  if (trialRow && !report.trial_switch.on_before) {
    await trialRow.toggle.click({ force: true });
    await page.waitForTimeout(1500);
    report.trial_switch.on_after = await trialRow.toggle.isChecked();
    report.caption_step_text_after_trial = await dialogText();
  }
  report.caption_step_screenshot = await screenshot(page, `${account.username}-caption-step`);

  if (capture) {
    // From Share on, every POST except the raw video upload is dropped, so neither the publish
    // request nor any fallback the website tries can create a post.
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && !/\/rupload_ig/.test(req.url())) return drop(route);
      return route.fallback();
    });
    await page.locator('div[role="dialog"]').getByRole("button", { name: labels.share }).first().click({ timeout: 10_000 });
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline && !blocked.some((b) => /configure/.test(b.path))) await page.waitForTimeout(1000);
    await page.waitForTimeout(5000); // catch any retry
    report.after_share_text = await dialogText();
    report.after_share_screenshot = await screenshot(page, `${account.username}-after-share`);
  }
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  report.error_screenshot = await screenshot(page, `${account.username}-inspect-error`);
} finally {
  report.trial_signals = signals;
  report.blocked = blocked;
  report.requests = [...requests];
  await context.close().catch(() => {});
}
console.log(JSON.stringify(report, null, 2));

/** Lines of page text that appear after clicking Create: the menu's items. */
async function readCreateMenu() {
  const lines = async () => (await page.evaluate(() => document.body.innerText)).split("\n").map((s) => s.trim()).filter(Boolean);
  const before = new Set(await lines());
  const triggers = [
    ...labels.newPostIcon.map((name) => page.locator(`svg[aria-label="${name}"]`).first()),
    page.getByRole("link", { name: labels.create }).first(),
    page.getByRole("button", { name: labels.create }).first(),
  ];
  for (const trigger of triggers) {
    if (await clickIfVisible(trigger)) return (await lines()).filter((t) => !before.has(t));
  }
  return null;
}

async function dialogText() {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    return (dialogs[dialogs.length - 1]?.innerText ?? "").trim().slice(0, 4000);
  });
}

/** Form fields of a request body, with signed_body's JSON unpacked. */
function decodeBody(data) {
  if (!data) return null;
  const fields = Object.fromEntries(new URLSearchParams(data));
  if (fields.signed_body?.startsWith("SIGNATURE.")) {
    try {
      fields.signed_body = JSON.parse(fields.signed_body.slice("SIGNATURE.".length));
    } catch {
      // left as text
    }
  }
  return fields;
}
