import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { call, idFrom, makeDataDir, seedAccounts, startClient } from "./helpers.mjs";

const { guardPublish, trialFieldsOf, withTrialFields } = await import("../dist/instagram/post.js");

const SET_ID = "set_0a1b2c3d";
const dirs = [];
const clients = [];

after(async () => {
  for (const c of clients) await c.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A data folder with one connected account and a ready set of three versions. */
function makeData() {
  const dataDir = makeDataDir();
  dirs.push(dataDir);
  seedAccounts(dataDir, ["testshop"]);
  const folder = path.join(dataDir, "versions", SET_ID);
  fs.mkdirSync(folder, { recursive: true });
  const versions = ["v1", "v2", "v3"].map((id) => {
    const file = path.join(folder, `${id}.mp4`);
    fs.writeFileSync(file, "fake video");
    return { id, spec: {}, changes: `${id} changes`, file, strip: file, duration: 6, width: 540, height: 960, size_mb: 0.1 };
  });
  const set = {
    id: SET_ID, status: "ready", source: path.join(folder, "source.mp4"), source_info: { duration: 6, width: 540, height: 960, fps: 30, video_codec: "h264", has_audio: true, size_bytes: 1 },
    specs: versions.map(() => ({})), folder, original_strip: path.join(folder, "original-strip.jpg"), created_at: new Date().toISOString(), versions,
  };
  fs.writeFileSync(path.join(folder, "set.json"), JSON.stringify(set));
  return dataDir;
}

async function client(fake, env = {}) {
  const c = await startClient({ TRIALPILOT_DATA_DIR: makeData(), TRIALPILOT_FAKE_POSTER: fake, ...env });
  clients.push(c);
  return c;
}

const versions = (...ids) => ids.map((version) => ({ version, caption: "Same caption for every version #test" }));

async function waitFor(c, batchId, done) {
  let status;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 300))) {
    status = (await call(c, "get_trial_status", { batch_id: batchId })).text;
    if (done(status)) return status;
  }
  assert.fail(`never got there:\n${status}`);
}

test("the publish request always carries the trial fields, however it was encoded", () => {
  const plain = "caption=hi&upload_id=123&clips_share_preview_to_feed=1";
  assert.equal(trialFieldsOf(plain).ok, false);
  const added = new URLSearchParams(withTrialFields(plain));
  assert.equal(added.get("trial_params"), '{"graduation_strategy":"manual"}');
  assert.equal(added.get("clips_share_preview_to_feed"), "0");
  assert.equal(added.get("caption"), "hi");
  // The website's own encoding is left as it is.
  const own = "upload_id=1&trial_params%5Bgraduation_strategy%5D=manual&clips_share_preview_to_feed=0";
  assert.equal(withTrialFields(own), own);
  assert.deepEqual(trialFieldsOf(own), { graduation_strategy: "manual", clips_share_preview_to_feed: "0", ok: true });
  const signed = `signed_body=${encodeURIComponent(`SIGNATURE.${JSON.stringify({ upload_id: "1" })}`)}`;
  const inside = JSON.parse(new URLSearchParams(withTrialFields(signed)).get("signed_body").slice("SIGNATURE.".length));
  assert.deepEqual([inside.trial_params, inside.clips_share_preview_to_feed], ['{"graduation_strategy":"manual"}', "0"]);
});

/** A stand-in for Playwright's Route that records what the guard did with the request. */
function route(url, body = "", headers = {}) {
  const r = {
    did: null,
    postData: null,
    request: () => ({ url: () => url, method: () => "POST", postData: () => body, headers: () => headers }),
    fallback: async () => void (r.did = "fallback"),
    abort: async () => void (r.did = "abort"),
    continue: async (o) => void ((r.did = "continue"), (r.postData = o?.postData)),
  };
  return r;
}

test("the publish guard lets the reel out only with its trial fields, and never in a test run", async () => {
  const configure = "https://www.instagram.com/api/v1/media/configure_to_clips/";
  const live = { test: false, sent: [], stopped: [], held: [] };
  const publish = route(configure, "caption=hi&upload_id=1");
  await guardPublish(publish, live);
  assert.equal(publish.did, "continue");
  assert.equal(trialFieldsOf(publish.postData).ok, true);

  const test = { test: true, sent: [], stopped: [], held: [] };
  const tried = route(configure, "caption=hi&upload_id=1");
  await guardPublish(tried, test);
  assert.equal(tried.did, "abort");
  assert.equal(test.sent[0].ok, true);
  const heldBack = route("https://www.instagram.com/api/v1/web/logging/falco", "x=1");
  await guardPublish(heldBack, test);
  assert.equal(heldBack.did, "abort", "a test run lets nothing out but the upload");
  assert.deepEqual(test.held, ["/api/v1/web/logging/falco"]);

  const upload = route("https://www.instagram.com/rupload_igvideo/fb_uploader_1");
  await guardPublish(upload, live);
  assert.equal(upload.did, "fallback");
  const otherWay = route("https://www.instagram.com/graphql/query", "doc_id=1", { "x-fb-friendly-name": "PolarisClipsPublishMutation" });
  await guardPublish(otherWay, live);
  assert.equal(otherWay.did, "abort");
  assert.deepEqual(live.stopped, ["PolarisClipsPublishMutation"]);
  const logging = route("https://www.instagram.com/api/v1/web/logging/falco", "x=1");
  await guardPublish(logging, live);
  assert.equal(logging.did, "fallback");
});

test("a trial is previewed, needs a yes, then goes out one version at a time", async () => {
  const c = await client("trial");
  const missing = await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v1", "v9") });
  assert.ok(missing.isError);
  assert.match(missing.text, /has no v9/);
  assert.match((await call(c, "preview_trial", { set_id: SET_ID, username: "nobody", versions: versions("v1") })).text, /@nobody isn't connected/);

  const preview = await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v1", "v2", "v3"), spacing_minutes: 45 });
  assert.ok(!preview.isError, preview.text);
  assert.match(preview.text, /3 trial reels from set_0a1b2c3d/);
  assert.match(preview.text, /When: right after the user's yes/);
  assert.match(preview.text, /When: 90 minutes after the first/);
  const previewId = idFrom(preview.text, "trialpreview");

  const refused = await call(c, "start_trial", { preview_id: previewId, user_confirmed: false });
  assert.ok(refused.isError);
  assert.match(refused.text, /Not started/);
  const started = await call(c, "start_trial", { preview_id: previewId, user_confirmed: true });
  assert.ok(!started.isError, started.text);
  const batchId = idFrom(started.text, "batch");
  const status = await waitFor(c, batchId, (s) => /v1, for .*: posted/.test(s));
  assert.match(status, /trial setting sent: graduation_strategy manual, clips_share_preview_to_feed 0/);
  assert.match(status, /link: https:\/\/www\.instagram\.com\/reel\/FAKE/);
  assert.match(status, /v2, for .*: scheduled/);
  assert.match(status, /v3, for .*: scheduled/);
  assert.match((await call(c, "start_trial", { preview_id: previewId, user_confirmed: true })).text, /already used/);

  const cancelled = await call(c, "cancel_trial", { batch_id: batchId });
  assert.match(cancelled.text, /Cancelled v2, v3/);
});

test("a test run goes through Share with nothing posted, and keeps the preview", async () => {
  const c = await client("trial");
  const previewId = idFrom((await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v2", "v3") })).text, "trialpreview");
  const tested = await call(c, "test_trial", { preview_id: previewId });
  assert.match(tested.text, /nothing is posted/);
  const testId = idFrom(tested.text, "test");
  let status;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && !/tested/.test(status ?? ""); await new Promise((r) => setTimeout(r, 300))) {
    status = (await call(c, "get_trial_status", { trial_id: testId })).text;
  }
  assert.match(status, /v2, test run: tested/);
  assert.ok(!(await call(c, "start_trial", { preview_id: previewId, user_confirmed: true })).isError, "the preview still works");
});

test("a reel that goes out as a normal reel stops trial posting on the account until the user says so", async () => {
  const c = await client("public");
  const previewId = idFrom((await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v1", "v2") })).text, "trialpreview");
  const batchId = idFrom((await call(c, "start_trial", { preview_id: previewId, user_confirmed: true })).text, "batch");
  const status = await waitFor(c, batchId, (s) => /went_public/.test(s) && /cancelled/.test(s));
  assert.match(status, /STOPPED: trial posting on @testshop is stopped\. v1 went out as a normal reel/);
  assert.match(status, /v2, for .*: cancelled/);
  assert.match((await call(c, "list_accounts")).text, /trial posting stopped/);

  const blocked = await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v2") });
  assert.match(blocked.text, /Trial posting on @testshop is stopped/);
  assert.match((await call(c, "resume_trial_posting", { username: "testshop", user_confirmed: false })).text, /Not resumed/);
  assert.match((await call(c, "resume_trial_posting", { username: "testshop", user_confirmed: true })).text, /can go on/);
  assert.ok(!(await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v2") })).isError);
});

test("a reel that can't be confirmed as a trial stops posting too", async () => {
  const c = await client("unknown");
  const previewId = idFrom((await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v1", "v2") })).text, "trialpreview");
  const batchId = idFrom((await call(c, "start_trial", { preview_id: previewId, user_confirmed: true })).text, "batch");
  const status = await waitFor(c, batchId, (s) => /needs_check/.test(s));
  assert.match(status, /STOPPED: .*never confirmed that v1 is a trial reel/);
});

test("an account Instagram doesn't offer trial reels to gets nothing posted", async () => {
  const c = await client("not_eligible");
  const previewId = idFrom((await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v1", "v2") })).text, "trialpreview");
  const batchId = idFrom((await call(c, "start_trial", { preview_id: previewId, user_confirmed: true })).text, "batch");
  const status = await waitFor(c, batchId, (s) => /failed/.test(s));
  assert.match(status, /doesn't offer trial reels to @testshop/);
  assert.match(status, /v2, for .*: cancelled/);
});

test("the daily limit is kept", async () => {
  const c = await client("trial", { TRIALPILOT_MAX_TRIALS_PER_DAY: "2" });
  const over = await call(c, "preview_trial", { set_id: SET_ID, username: "testshop", versions: versions("v1", "v2", "v3"), spacing_minutes: 10 });
  assert.ok(over.isError);
  assert.match(over.text, /would have 3 trial reels on .*the daily limit is 2/);
});
