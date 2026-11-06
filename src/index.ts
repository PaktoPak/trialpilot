import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserBusyError, installChromium, NoBrowserError, resolveBrowser } from "./browser.js";
import { paths } from "./config.js";
import { ffmpegDownload, ffmpegVersion, installFfmpeg, NoFfmpegError, resolveFfmpeg } from "./ffmpeg.js";
import { getConnect, startConnect, verifyAccount } from "./instagram/connect.js";
import { getAccount, getAccounts, getTrials, logAction, removeAccount, type Account, type TrialPost, type TrialStatus } from "./store.js";
import { cancelTrials, createTrialPreview, resumeTrialPosting, runDueTrials, SPACING, trialsFromPreview } from "./trials.js";
import { ensureDir, errorMessage, localTime, log, mapLimit, normalizeUsername, UserError } from "./util.js";
import { hdrKind } from "./video/hdr.js";
import { LIMITS, listVersionSets, prepareVersions, readVersionSet, renderVersions, versionsDone, type VersionSet, type VersionSpec } from "./video/versions.js";
import { listVideos, resolveVideo } from "./videos.js";

const VERSION = "0.2.0";

const INSTRUCTIONS = `Trialpilot tests several versions of one video as Instagram trial reels, through instagram.com in a local browser window with one saved sign-in per account.
- Sign-in: the user signs in themselves in the window connect_account opens. Never ask for passwords or security codes in chat.
- Videos: give make_versions a full path, or the name of a file in the videos folder (list_videos).
- Versions: make 2 to 5, each changing one thing (hook, opening, speed, zoom, look, mirror or sound), so the results show which change worked. Then go through every version with the user from get_versions: what it changes, how its strip of frames looks, and where its file is, so they can watch it.
- Music: only add a track the user owns or has the rights to use. Never make versions to get a song past Instagram's copyright checks.
- FFmpeg: make_versions needs it. If it's missing, ask the user before install_ffmpeg, saying what it downloads, from where and how big.
- Trial reels: preview_trial checks which versions go out on which account, with which captions and when, and returns a preview. Show the user all of it and get a clear yes before start_trial with user_confirmed true. Each preview can be started once.
- Captions: give every version the same caption unless the user wants to test captions, so the edit is the only difference.
- The first time on an account, suggest test_trial: it goes through every step, Share included, and stops the publish request, so nothing is posted.
- Trialpilot posts each version itself at its time, 30 minutes apart by default, so Claude Desktop has to stay open until the last one has gone out.
- If a reel goes out as a normal reel, or Trialpilot can't confirm it's a trial reel, it stops trial posting on that account and shows a notification. Tell the user straight away, with the link. Call resume_trial_posting only after the user has checked that reel on Instagram and says to go on.
- Times: pass ISO 8601 with the user's timezone offset, and say times back to the user in their local time.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const problem = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserError || e instanceof NoBrowserError || e instanceof BrowserBusyError || e instanceof NoFfmpegError) return problem(e.message);
    log("tool error", e);
    return problem(`Something went wrong: ${errorMessage(e)}`);
  }
}

function describeAccount(a: Account): string {
  const kind = a.account_type === "unknown" ? "account type unknown" : `${a.account_type} account`;
  const visibility = a.is_private === undefined ? "" : a.is_private ? ", private (trial reels need a public account)" : ", public";
  const status = a.status === "connected" ? "signed in" : "needs to sign in again (connect_account with this username)";
  const stopped = a.trial_stop ? `; trial posting stopped on ${localTime(a.trial_stop.at)}: ${a.trial_stop.reason}` : "";
  return `@${a.username}${a.full_name ? ` (${a.full_name})` : ""}: ${kind}${visibility}; ${status}${stopped}`;
}

const server = new McpServer({ name: "trialpilot", version: VERSION }, { instructions: INSTRUCTIONS });

// Accounts

server.registerTool(
  "connect_account",
  {
    title: "Connect an Instagram account",
    description:
      "Opens a browser window on Instagram's sign-in page so the user can sign in to one of their accounts. The user types their own login details and any security code in that window; never ask for them in chat. Returns a connect_id right away: tell the user to sign in in the window, then call check_connection. Pass username only to sign an already-connected account back in.",
    inputSchema: { username: z.string().optional().describe("Only when signing an already-connected account back in, e.g. 'myshop'.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ username }) =>
    run(async () => {
      const existing = username ? await getAccount(username) : undefined;
      if (username && !existing) throw new UserError(`@${normalizeUsername(username)} isn't connected yet. Call connect_account without a username to add it.`);
      const state = await startConnect(existing);
      if (state.status === "connected" && state.account) return ok(`${state.message} It was already signed in.\n${describeAccount(state.account)}`);
      if (state.status !== "waiting") return problem(state.message);
      return ok(
        `connect_id: ${state.id}\nA browser window opened on Instagram's sign-in page. Ask the user to sign in there${existing ? ` as @${existing.username}` : ""}, including any security code, then call check_connection with this connect_id. The window closes by itself once they're signed in, or after 10 minutes.`,
      );
    }),
);

server.registerTool(
  "check_connection",
  {
    title: "Check a sign-in",
    description: "Reports whether the user has finished signing in to the window connect_account opened.",
    inputSchema: { connect_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ connect_id }) =>
    run(async () => {
      const state = getConnect(connect_id);
      if (!state) return problem("Unknown connect_id. Trialpilot may have restarted since; call connect_account again.");
      if (state.status === "waiting") return ok("Still waiting for the user to finish signing in to the browser window.");
      if (state.status === "connected" && state.account) return ok(`${state.message}\n${describeAccount(state.account)}`);
      return problem(state.message);
    }),
);

server.registerTool(
  "list_accounts",
  {
    title: "List connected accounts",
    description: "Lists every connected Instagram account with its type, public or private, and whether it is still signed in.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    run(async () => {
      const accounts = await getAccounts();
      if (!accounts.length) return ok("No accounts connected yet. Use connect_account to add one.");
      return ok(accounts.map(describeAccount).join("\n"));
    }),
);

server.registerTool(
  "check_account",
  {
    title: "Check sign-ins",
    description: "Opens each account's browser window briefly to confirm it is still signed in and refresh its details. Leave out username to check every connected account.",
    inputSchema: { username: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ username }) =>
    run(async () => {
      if (username) {
        const account = await getAccount(username);
        if (!account) throw new UserError(`@${normalizeUsername(username)} isn't connected.`);
        return ok(describeAccount(await verifyAccount(account)));
      }
      const accounts = await getAccounts();
      if (!accounts.length) return ok("No accounts connected yet. Use connect_account to add one.");
      // One window per account, a few at a time.
      const lines = await mapLimit(accounts, 3, async (account) => {
        try {
          return describeAccount(await verifyAccount(account));
        } catch (e) {
          return `@${account.username}: couldn't check (${errorMessage(e)})`;
        }
      });
      return ok(lines.join("\n"));
    }),
);

server.registerTool(
  "disconnect_account",
  {
    title: "Disconnect an account",
    description: "Deletes Trialpilot's saved sign-in for an account. Nothing changes on Instagram itself. Confirm with the user first, then call with user_confirmed true.",
    inputSchema: { username: z.string(), user_confirmed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ username, user_confirmed }) =>
    run(async () => {
      const account = await getAccount(username);
      if (!account) throw new UserError(`@${normalizeUsername(username)} isn't connected.`);
      if (!user_confirmed) throw new UserError(`Ask the user first: this deletes the saved sign-in for @${account.username}. Instagram itself is not changed.`);
      await fs.rm(account.profile_dir, { recursive: true, force: true });
      await removeAccount(account.username);
      await logAction({ action: "disconnect", account: account.username, ok: true });
      return ok(`Disconnected @${account.username}. Its versions were left in place.`);
    }),
);

// Versions

server.registerTool(
  "list_videos",
  {
    title: "List videos",
    description: "Lists the videos and music in Trialpilot's videos folder, newest first. make_versions takes these names, or a full path to a video anywhere else.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    run(async () => {
      const files = await listVideos();
      if (!files.length) return ok(`The videos folder is empty: ${paths.videos}\nThe user can drop videos and music there, or give make_versions a full path.`);
      return ok([paths.videos, ...files.map((f) => `  ${f.name}: ${f.type}, ${f.size_mb} MB, added ${localTime(f.modified)}`)].join("\n"));
    }),
);

const [minSpeed, maxSpeed] = LIMITS.speed;
const versionSchema = z
  .object({
    hook: z
      .object({
        text: z.string().describe("A new opening line over the first seconds, at most 120 characters. Emoji work."),
        position: z.enum(["top", "middle", "bottom"]).optional().describe("Default top. All three stay clear of Instagram's buttons and caption."),
        style: z.enum(["box", "outline"]).optional().describe("box (default): black text on white; outline: white text with a black edge."),
        seconds: z.number().optional().describe(`How long it shows, ${LIMITS.hookSeconds[0]} to ${LIMITS.hookSeconds[1]} seconds; default 4.`),
      })
      .strict()
      .optional(),
    start_at: z.number().optional().describe("A different opening: start this many seconds in."),
    front_clip: z
      .object({ from: z.number(), to: z.number() })
      .strict()
      .optional()
      .describe("A different opening: this moment, in seconds of the source, moves to the front; the rest plays in order after it."),
    speed: z.number().optional().describe(`Playback speed, ${minSpeed} to ${maxSpeed}. The sound keeps its pitch.`),
    zoom: z.number().optional().describe(`Zoom in, 1 to ${LIMITS.zoom[1]} (at most 5%), keeping the top of the frame in place.`),
    look: z
      .object({
        contrast: z.number().optional().describe(`${LIMITS.contrast[0]} to ${LIMITS.contrast[1]}; 1 is unchanged.`),
        temperature: z.number().optional().describe(`Colour temperature in kelvin, ${LIMITS.temperature[0]} to ${LIMITS.temperature[1]}; 6500 is unchanged, lower is warmer.`),
        grain: z.number().optional().describe(`Film grain, 0 to ${LIMITS.grain[1]}.`),
        vignette: z.boolean().optional().describe("Darker corners."),
      })
      .strict()
      .optional(),
    mirror: z.boolean().optional().describe("Flip left to right. Text and logos in the video flip too; a hook doesn't."),
    audio: z
      .object({
        track: z.string().optional().describe("Music to mix in: a full path or a name in the videos folder. Only music the user has the rights to."),
        track_volume: z.number().optional().describe("0 to 2; 1 is unchanged."),
        original_volume: z.number().optional().describe("The video's own sound, 0 (off) to 2; 1 is unchanged."),
      })
      .strict()
      .optional(),
  })
  .strict();

server.registerTool(
  "make_versions",
  {
    title: "Make versions of a video",
    description:
      "Makes 1 to 5 lightly edited versions of one video to test as trial reels. Change one thing per version so the results show which change worked. Each version is an H.264 MP4 of at most 1080×1920, without the original's metadata. HDR videos (most iPhone videos are) come out in normal colour. Checks everything first and refuses in plain words; then renders in the background and returns a set_id right away. Call get_versions with it to see each version's strip of frames (usually ready in a minute or two).",
    inputSchema: {
      video: z.string().describe("A full path, or the name of a file in the videos folder."),
      versions: z.array(versionSchema).min(1).max(LIMITS.versions),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ video, versions }) =>
    run(async () => {
      const specs: VersionSpec[] = versions.map((v) => (v.audio?.track ? { ...v, audio: { ...v.audio, track: resolveVideo(v.audio.track) } } : v));
      const set = await prepareVersions(resolveVideo(video), specs);
      void renderVersions(set).catch((e) => log(`rendering ${set.id} failed:`, errorMessage(e)));
      const { width, height, duration } = set.source_info;
      return ok(
        `set_id: ${set.id}\nRendering ${specs.length} version${specs.length > 1 ? "s" : ""} of ${path.basename(set.source)} (${width}×${height}, ${duration.toFixed(1)} s). Call get_versions with this set_id in about a minute.`,
      );
    }),
);

function describeSet(set: VersionSet): string {
  const what = `${set.specs.length} version${set.specs.length > 1 ? "s" : ""} of ${path.basename(set.source)}, made ${localTime(set.created_at)}`;
  if (set.status === "rendering") return `${set.id}: rendering ${what}; ${versionsDone(set.id) ?? 0} done`;
  if (set.status === "failed") return `${set.id}: failed, ${what}: ${set.error}`;
  return `${set.id}: ready, ${what}`;
}

async function image(file: string): Promise<Content> {
  return { type: "image", data: (await fs.readFile(file)).toString("base64"), mimeType: "image/jpeg" };
}

server.registerTool(
  "get_versions",
  {
    title: "See versions",
    description:
      "Shows a set from make_versions: whether it's still rendering, and once ready, a strip of six frames from the original and from each version, with what each changes and where its file is. Leave out set_id to list recent sets.",
    inputSchema: { set_id: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ set_id }) =>
    run(async () => {
      if (!set_id) {
        const sets = (await listVersionSets()).slice(0, 20);
        return ok(sets.length ? sets.map(describeSet).join("\n") : "No versions made yet.");
      }
      const set = await readVersionSet(set_id);
      if (!set) throw new UserError(`There's no set with id ${set_id}.`);
      if (set.status === "rendering") return ok(`Still rendering: ${versionsDone(set.id) ?? 0} of ${set.specs.length} done. Check again in a minute.`);
      if (set.status === "failed") return problem(`These versions couldn't be made: ${set.error}`);
      const { width, height, duration } = set.source_info;
      const content: Content[] = [
        {
          type: "text",
          text: `${describeSet(set)}\nFolder: ${set.folder}\nEach strip shows six moments from start to end, more of them from the opening, where a hook shows.\n\nOriginal: ${width}×${height}, ${duration.toFixed(1)} s${hdrKind(set.source_info) ? ", HDR (its versions and this strip are in normal colour)" : ""}`,
        },
        await image(set.original_strip),
      ];
      for (const v of set.versions) {
        content.push({ type: "text", text: `${v.id}: ${v.changes}. ${v.width}×${v.height}, ${v.duration} s, ${v.size_mb} MB, ${v.file}` }, await image(v.strip));
      }
      content.push({ type: "text", text: "Go through each version with the user: what it changes, how its strip looks, and where its file is." });
      return { content };
    }),
);

// Trial reels

const TRIAL_MEANING: Record<TrialStatus, string> = {
  scheduled: "waiting for its time",
  posting: "going out now",
  posted: "live as a trial reel: shown to people who don't follow the account, not on its profile grid",
  tested: "test run finished; nothing was posted",
  failed: "didn't go out",
  needs_check: "may be up; check the profile and its trial reels before anything else",
  went_public: "went out as a normal reel, so trial posting on this account stopped",
  missed: "its time passed while Trialpilot wasn't running, so it didn't go out",
  cancelled: "didn't go out",
};

function describeTrial(t: TrialPost): string {
  const when = t.type === "test" ? "test run" : `for ${localTime(t.run_at)}`;
  const caption = t.caption ? JSON.stringify(t.caption.length > 120 ? `${t.caption.slice(0, 117)}...` : t.caption) : "(none)";
  const lines = [`${t.id}: @${t.account} ${t.version}, ${when}: ${t.status} (${TRIAL_MEANING[t.status]})`, `  caption: ${caption}`];
  if (t.result?.url) lines.push(`  link: ${t.result.url}`);
  if (t.result?.sent) lines.push(`  trial setting sent: ${Object.entries(t.result.sent).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (t.note) lines.push(`  note: ${t.note}`);
  if (t.result?.note) lines.push(`  note: ${t.result.note}`);
  if (t.error) lines.push(`  problem at step "${t.error.step}": ${t.error.message}${t.error.screenshot ? ` (screenshot: ${t.error.screenshot})` : ""}`);
  return lines.join("\n");
}

server.registerTool(
  "preview_trial",
  {
    title: "Preview a trial",
    description:
      "Checks versions from make_versions going out as trial reels on one account: each version with its caption and time (the first right after the user's yes unless start_at is given, then one every spacing_minutes), the account and the daily limit. Returns a preview_id. Show the user the whole preview and get a clear yes before start_trial.",
    inputSchema: {
      set_id: z.string(),
      username: z.string().describe("The account to post from."),
      versions: z
        .array(
          z
            .object({
              version: z.string().describe("v1, v2 and so on, from get_versions."),
              caption: z.string().default("").describe("The caption, hashtags included. Line breaks and emoji are kept."),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.versions)
        .describe("In the order they go out."),
      start_at: z.string().optional().describe("When the first goes out: ISO 8601 with the user's timezone offset. Leave out for right after the user's yes."),
      spacing_minutes: z.number().int().optional().describe(`Minutes between versions, ${SPACING.min} to ${SPACING.max}; ${SPACING.default} if left out.`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (request) =>
    run(async () => {
      const preview = await createTrialPreview(request);
      const last = preview.items[preview.items.length - 1];
      const blocks = preview.items.flatMap((item, i) => [
        "",
        `${i + 1}. ${item.version}: ${item.changes}`,
        `File: ${item.file}`,
        "Caption:",
        item.caption || "(none)",
        `When: ${preview.starts_now ? (i === 0 ? "right after the user's yes" : `${i * preview.spacing_minutes} minutes after the first`) : localTime(item.run_at)}`,
      ]);
      const span = ((preview.items.length - 1) * preview.spacing_minutes) / 60;
      return ok(
        [
          `preview_id: ${preview.id} (valid for 30 minutes)`,
          `@${preview.account}: ${preview.items.length} trial reel${preview.items.length > 1 ? "s" : ""} from ${preview.set_id}. Trial reels are shown to people who don't follow the account first. They don't appear on its profile grid or in its followers' feeds, and the user can share the best one to followers later.`,
          ...blocks,
          "",
          preview.items.length > 1
            ? `Trialpilot posts each one itself at its time, so Claude Desktop has to stay open until the last one${preview.starts_now ? `, about ${span >= 1 ? `${span} hour${span === 1 ? "" : "s"}` : `${span * 60} minutes`} after the first` : ` (${localTime(last.run_at)})`}.`
            : "Trialpilot posts it itself, so Claude Desktop has to be open at that time.",
          "Show this preview to the user and ask for a clear yes. Then call start_trial with this preview_id and user_confirmed true. To try the steps first with nothing posted, call test_trial.",
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "start_trial",
  {
    title: "Start a trial",
    description:
      "Posts the versions in a preview as trial reels, each at its time. Only call this after showing the user the preview from preview_trial and getting an explicit yes in this conversation; set user_confirmed true only then.",
    inputSchema: { preview_id: z.string(), user_confirmed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ preview_id, user_confirmed }) =>
    run(async () => {
      if (!user_confirmed) throw new UserError("Not started. Show the user the preview, get a clear yes, then call again with user_confirmed true.");
      const { batch_id, trials } = await trialsFromPreview(preview_id, "post");
      void runDueTrials();
      const last = trials[trials.length - 1];
      return ok(
        [
          `batch_id: ${batch_id}. ${trials.length} trial reel${trials.length > 1 ? "s" : ""} on @${trials[0].account}:`,
          ...trials.map((t) => `- ${t.version} (${t.id}): ${Date.parse(t.run_at) <= Date.now() + 1000 ? "now" : localTime(t.run_at)}`),
          `A browser window opens and posts each one at its time, so Claude Desktop has to stay open until ${localTime(last.run_at)}. Check get_trial_status with the batch_id.`,
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "test_trial",
  {
    title: "Test a trial without posting",
    description:
      "Runs every posting step for the first version in a preview, Share included, and stops the publish request, so nothing is posted. Shows the trial setting the request carried. The preview stays valid for start_trial. Check the result with get_trial_status.",
    inputSchema: { preview_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ preview_id }) =>
    run(async () => {
      const { trials } = await trialsFromPreview(preview_id, "test");
      void runDueTrials();
      const [t] = trials;
      return ok(
        `Test run started on @${t.account} with ${t.version} (${t.id}). A browser window adds the video and caption and clicks Share, and Trialpilot stops the publish request, so nothing is posted. Check get_trial_status in a couple of minutes. The preview stays valid for start_trial.`,
      );
    }),
);

server.registerTool(
  "get_trial_status",
  {
    title: "Trial status",
    description:
      "Shows where trial reels stand: every one in a batch with batch_id, one with trial_id, or the most recent ones with neither. Includes links, the trial setting each publish request carried, and screenshots.",
    inputSchema: { batch_id: z.string().optional(), trial_id: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ batch_id, trial_id }) =>
    run(async () => {
      const all = await getTrials();
      const trials = batch_id ? all.filter((t) => t.batch_id === batch_id) : trial_id ? all.filter((t) => t.id === trial_id) : all.slice(-20);
      if (!trials.length) {
        if (batch_id || trial_id) throw new UserError(`There's no trial with id ${batch_id ?? trial_id}.`);
        return ok("No trial reels yet.");
      }
      const stopped = (await getAccounts()).filter((a) => a.trial_stop && trials.some((t) => t.account === a.username));
      const banner = stopped.map((a) => `STOPPED: trial posting on @${a.username} is stopped. ${a.trial_stop!.reason} Tell the user now.`);
      const content: Content[] = [{ type: "text", text: [...banner, ...trials.map(describeTrial)].join("\n") }];
      for (const t of trials.slice(-4)) {
        const shot = t.result?.screenshot ?? t.error?.screenshot;
        const data = shot ? await fs.readFile(shot).catch(() => null) : null;
        if (data) content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
      }
      return { content };
    }),
);

server.registerTool(
  "cancel_trial",
  {
    title: "Cancel a trial",
    description: "Cancels the trial reels in a batch that haven't gone out yet. Confirm with the user first.",
    inputSchema: { batch_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ batch_id }) =>
    run(async () => {
      const cancelled = await cancelTrials(batch_id);
      return ok(cancelled.length ? `Cancelled ${cancelled.map((t) => t.version).join(", ")}. Reels already out stay up.` : "Nothing left to cancel: every reel in that batch has already gone out or stopped.");
    }),
);

server.registerTool(
  "resume_trial_posting",
  {
    title: "Resume trial posting",
    description:
      "Lets trial posting go on on an account after Trialpilot stopped it. Only after the user has checked, on Instagram, the reel that caused the stop and said to go on; set user_confirmed true only then. Trial reels it cancelled stay cancelled.",
    inputSchema: { username: z.string(), user_confirmed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ username, user_confirmed }) =>
    run(async () => {
      if (!user_confirmed) throw new UserError("Not resumed. Ask the user to check that reel on Instagram first, and resume only when they say so.");
      const account = await resumeTrialPosting(username);
      return ok(`Trial posting on @${account.username} can go on. Run preview_trial again for the versions that didn't go out.`);
    }),
);

// Setup

// FFmpeg downloads in the background; this is where it stands, until it's found.
let ffmpegInstall: { status: "downloading" | "failed"; message: string } | undefined;

async function ffmpegStatus(): Promise<string> {
  const tools = resolveFfmpeg();
  if (tools) {
    const version = await ffmpegVersion(tools).catch((e) => `doesn't work: ${errorMessage(e)}`);
    return `${tools.ffmpeg} (${version})`;
  }
  if (ffmpegInstall) return ffmpegInstall.message;
  const download = ffmpegDownload();
  return download
    ? `not found. install_ffmpeg can download it (about ${download.size_mb} MB from ${download.site}) once the user says yes.`
    : "not found. Install FFmpeg, or set its path in the extension settings.";
}

server.registerTool(
  "get_setup_status",
  {
    title: "Setup status",
    description: "Shows Trialpilot's folders, the browser and FFmpeg it uses, and the connected accounts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    run(async () => {
      const browser = resolveBrowser();
      const accounts = await getAccounts();
      return ok(
        [
          `Trialpilot ${VERSION}`,
          `Data folder: ${paths.data}`,
          `Videos folder: ${paths.videos}`,
          `Browser: ${browser ? `${browser.label} (${browser.executablePath})` : "none found; install Google Chrome or use install_browser"}`,
          `FFmpeg: ${await ffmpegStatus()}`,
          `Accounts: ${accounts.length ? accounts.map((a) => `@${a.username}`).join(", ") : "none yet"}`,
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "install_ffmpeg",
  {
    title: "Download FFmpeg",
    description:
      "make_versions needs FFmpeg. When get_setup_status says it's missing, ask the user first: it downloads FFmpeg (about 60 MB on a Mac, 115 MB on Windows) into Trialpilot's folder, from ffmpeg.martin-riedl.de on a Mac or gyan.dev on Windows. FFmpeg is free software under the GPL, downloaded on its own rather than included in Trialpilot. Call with user_confirmed true only after their yes. It downloads in the background; get_setup_status shows when it's ready.",
    inputSchema: { user_confirmed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ user_confirmed }) =>
    run(async () => {
      const found = resolveFfmpeg();
      if (found) return ok(`FFmpeg is already available (${found.ffmpeg}), so there's nothing to download.`);
      if (ffmpegInstall?.status === "downloading") return ok(`${ffmpegInstall.message} Check get_setup_status in a minute.`);
      const download = ffmpegDownload();
      if (!download) throw new UserError("Trialpilot can download FFmpeg on a Mac or a Windows PC only. Install it yourself, or set its path in the extension settings.");
      if (!user_confirmed) {
        throw new UserError(`Not downloaded. Ask the user first: this downloads FFmpeg (about ${download.size_mb} MB) from ${download.site} into ${paths.bin}. Then call again with user_confirmed true.`);
      }
      ffmpegInstall = { status: "downloading", message: `Downloading from ${download.site}, started ${localTime(new Date().toISOString())}.` };
      void installFfmpeg(download).then(
        async (version) => {
          ffmpegInstall = undefined;
          await logAction({ action: "install_ffmpeg", ok: true, detail: version });
        },
        async (e) => {
          ffmpegInstall = { status: "failed", message: `not found; the download failed: ${errorMessage(e)}` };
          await logAction({ action: "install_ffmpeg", ok: false, detail: errorMessage(e) });
        },
      );
      return ok(`Downloading FFmpeg (about ${download.size_mb} MB) from ${download.site}. It usually takes a minute or two; check get_setup_status.`);
    }),
);

server.registerTool(
  "install_browser",
  {
    title: "Download a browser",
    description:
      "Only for computers without Google Chrome or Microsoft Edge: downloads Chromium (about 150 MB) from Playwright's download servers. Ask the user before calling.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async () =>
    run(async () => {
      const existing = resolveBrowser();
      if (existing) return ok(`${existing.label} is already available, so there's nothing to download.`);
      const output = await installChromium();
      await logAction({ action: "install_browser", ok: true });
      return ok(`Downloaded Chromium.\n${output}`);
    }),
);

await ensureDir(paths.videos);
await server.connect(new StdioServerTransport());
server.server.onclose = () => process.exit(0);
log(`started, data folder ${paths.data}`);

// While Claude Desktop is open, the extension posts due trial reels itself.
const tick = () => {
  runDueTrials().catch((e) => log("trial run failed:", errorMessage(e)));
};
setTimeout(tick, 5_000);
setInterval(tick, 30_000);
