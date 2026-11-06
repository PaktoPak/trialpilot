import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { call, idFrom, makeDataDir, makeSource, ownFfmpeg, root, seedAccounts, startClient } from "./helpers.mjs";

const { resolveBrowser } = await import("../dist/browser.js");

const hasFfmpeg = fs.existsSync(ownFfmpeg);
const canRender = hasFfmpeg && resolveBrowser() ? false : "needs FFmpeg in ~/Trialpilot/bin and Chrome or Chromium";
const systemFfmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].some((p) => fs.existsSync(p));

let client;
let dataDir;

before(async () => {
  dataDir = makeDataDir();
  seedAccounts(dataDir, ["testshop", "otherbrand"]);
  client = await startClient({ TRIALPILOT_DATA_DIR: dataDir, TRIALPILOT_FFMPEG_PATH: hasFfmpeg ? ownFfmpeg : "" });
});

after(async () => {
  await client?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("offers every tool, and the manifest lists the same ones", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cancel_trial", "check_account", "check_connection", "connect_account", "disconnect_account", "get_setup_status", "get_trial_status",
    "get_versions", "install_browser", "install_ffmpeg", "list_accounts", "list_videos", "make_versions", "preview_trial",
    "resume_trial_posting", "start_trial", "test_trial",
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), names);
});

test("lists connected accounts", async () => {
  const { text } = await call(client, "list_accounts");
  assert.match(text, /@testshop: business account, public; signed in/);
  assert.match(text, /@otherbrand/);
});

test("disconnecting needs the user's OK", async () => {
  const refused = await call(client, "disconnect_account", { username: "otherbrand", user_confirmed: false });
  assert.ok(refused.isError);
  assert.match(refused.text, /Ask the user first/);
  const done = await call(client, "disconnect_account", { username: "@OtherBrand", user_confirmed: true });
  assert.match(done.text, /Disconnected @otherbrand/);
  assert.doesNotMatch((await call(client, "list_accounts")).text, /otherbrand/);
});

test("lists the videos and music in the videos folder, skipping other files", async () => {
  const videos = path.join(dataDir, "videos");
  for (const name of ["a.mp4", "song.m4a", "notes.txt"]) fs.writeFileSync(path.join(videos, name), "fake");
  const { text } = await call(client, "list_videos");
  assert.match(text, /a\.mp4: video/);
  assert.match(text, /song\.m4a: audio/);
  assert.doesNotMatch(text, /notes\.txt/);
});

test("make_versions refuses what it can't make, in plain words", { skip: !hasFfmpeg && "needs FFmpeg in ~/Trialpilot/bin" }, async () => {
  makeSource(ownFfmpeg, path.join(dataDir, "videos"), "short.mp4");
  const missing = await call(client, "make_versions", { video: "nothing.mp4", versions: [{ speed: 1.05 }] });
  assert.ok(missing.isError);
  assert.match(missing.text, /Can't find the video .*nothing\.mp4/);
  const tooFast = await call(client, "make_versions", { video: "short.mp4", versions: [{ speed: 1.3 }] });
  assert.ok(tooFast.isError);
  assert.match(tooFast.text, /Version 1: speed has to be between 0\.9 and 1\.1/);
  const unknown = await call(client, "make_versions", { video: "short.mp4", versions: [{ sped: 1.05 }] });
  assert.ok(unknown.isError);
  assert.match(unknown.text, /sped/);
});

test("renders versions in the background, then shows a strip for each", { skip: canRender }, async () => {
  makeSource(ownFfmpeg, path.join(dataDir, "videos"), "clip.mp4");
  const started = await call(client, "make_versions", { video: "clip.mp4", versions: [{ hook: { text: "Wait for it" } }, { speed: 1.05 }] });
  assert.ok(!started.isError, started.text);
  const setId = idFrom(started.text, "set");
  assert.ok(setId, started.text);

  let result;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 500))) {
    result = await call(client, "get_versions", { set_id: setId });
    if (!/Still rendering/.test(result.text)) break;
  }
  assert.ok(!result.isError, result.text);
  assert.match(result.text, /v1: hook "Wait for it" \(top, box, first 4 s\)/);
  assert.match(result.text, /v2: 1\.05× speed/);
  const images = result.content.filter((c) => c.type === "image");
  assert.equal(images.length, 3, "the original and both versions");
  for (const img of images) assert.equal(Buffer.from(img.data, "base64").subarray(0, 2).toString("hex"), "ffd8", "a JPEG");

  assert.match((await call(client, "get_versions")).text, new RegExp(`${setId}: ready, 2 versions of clip\\.mp4`));
});

test("an unknown set is refused", async () => {
  const { text, isError } = await call(client, "get_versions", { set_id: "set_00000000" });
  assert.ok(isError);
  assert.match(text, /no set with id set_00000000/);
});

test("setup status shows the folders and FFmpeg", async () => {
  const { text } = await call(client, "get_setup_status");
  assert.ok(text.includes(`Videos folder: ${path.join(dataDir, "videos")}`), text);
  if (hasFfmpeg) assert.match(text, /FFmpeg: .*ffmpeg version/);
  assert.match(text, /Accounts: @testshop/);
});

test("install_ffmpeg has nothing to do when FFmpeg is there", { skip: !hasFfmpeg && "needs FFmpeg in ~/Trialpilot/bin" }, async () => {
  const { text } = await call(client, "install_ffmpeg", { user_confirmed: false });
  assert.match(text, /already available/);
});

test("without FFmpeg, nothing downloads until the user says yes", { skip: systemFfmpeg && "this computer has FFmpeg installed" }, async () => {
  const bareDir = makeDataDir();
  const bare = await startClient({
    TRIALPILOT_DATA_DIR: bareDir,
    TRIALPILOT_FFMPEG_PATH: "",
    PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
  });
  try {
    assert.match((await call(bare, "get_setup_status")).text, /FFmpeg: not found\. install_ffmpeg can download it \(about \d+ MB from [\w.-]+\) once the user says yes/);
    const refused = await call(bare, "install_ffmpeg", { user_confirmed: false });
    assert.ok(refused.isError);
    assert.match(refused.text, /Not downloaded\. Ask the user first/);
    const noTools = await call(bare, "make_versions", { video: "clip.mp4", versions: [{ speed: 1.05 }] });
    assert.ok(noTools.isError);
    assert.match(noTools.text, /FFmpeg isn't installed/);
    assert.ok(!fs.existsSync(path.join(bareDir, "bin")));
  } finally {
    await bare.close();
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});
