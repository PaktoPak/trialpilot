import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserBusyError, installChromium, NoBrowserError, resolveBrowser } from "./browser.js";
import { paths } from "./config.js";
import { ffmpegDownload, ffmpegVersion, installFfmpeg, NoFfmpegError, resolveFfmpeg } from "./ffmpeg.js";
import { getConnect, startConnect, verifyAccount } from "./instagram/connect.js";
import { getAccount, getAccounts, logAction, removeAccount, type Account } from "./store.js";
import { ensureDir, errorMessage, localTime, log, mapLimit, normalizeUsername, UserError } from "./util.js";
import { LIMITS, listVersionSets, prepareVersions, readVersionSet, renderVersions, versionsDone, type VersionSet, type VersionSpec } from "./video/versions.js";
import { listVideos, resolveVideo } from "./videos.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Trialpilot tests several versions of one video as Instagram trial reels, through instagram.com in a local browser window with one saved sign-in per account.
- Sign-in: the user signs in themselves in the window connect_account opens. Never ask for passwords or security codes in chat.
- Videos: give make_versions a full path, or the name of a file in the videos folder (list_videos).
- Versions: make 2 to 5, each changing one thing (hook, opening, speed, zoom, look, mirror or sound), so the results show which change worked. Then go through every version with the user from get_versions: what it changes, how its strip of frames looks, and where its file is, so they can watch it.
- Music: only add a track the user owns or has the rights to use. Never make versions to get a song past Instagram's copyright checks.
- FFmpeg: make_versions needs it. If it's missing, ask the user before install_ffmpeg, saying what it downloads, from where and how big.
- Trial reel posting isn't built yet: nothing in Trialpilot posts to Instagram.`;

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
  return `@${a.username}${a.full_name ? ` (${a.full_name})` : ""}: ${kind}${visibility}; ${status}`;
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
      "Makes 1 to 5 lightly edited versions of one video to test as trial reels. Change one thing per version so the results show which change worked. Each version is an H.264 MP4 of at most 1080×1920, without the original's metadata. Checks everything first and refuses in plain words; then renders in the background and returns a set_id right away. Call get_versions with it to see each version's strip of frames (usually ready in a minute or two).",
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
          text: `${describeSet(set)}\nFolder: ${set.folder}\nEach strip shows six moments from start to end, more of them from the opening, where a hook shows.\n\nOriginal: ${width}×${height}, ${duration.toFixed(1)} s`,
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
