import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Config is read on import, so the data folder has to be set first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trialpilot-test-"));
process.env.TRIALPILOT_DATA_DIR = dataDir;
delete process.env.TRIALPILOT_FFMPEG_PATH;
const { ffmpegDownload, installFfmpeg } = await import("../dist/ffmpeg.js");

const bin = path.join(dataDir, "bin");
const scripts = process.platform === "win32" ? "uses shell scripts in place of ffmpeg" : false;

test("each computer gets a build for its system", () => {
  assert.deepEqual(ffmpegDownload("darwin", "arm64").zips, [
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip",
  ]);
  assert.match(ffmpegDownload("darwin", "x64").zips[1], /macos\/amd64\/release\/ffprobe\.zip$/);
  assert.equal(ffmpegDownload("win32", "x64").site, "gyan.dev");
  assert.equal(ffmpegDownload("linux", "x64"), null);
});

// Stand-ins that answer the way ffmpeg and ffprobe do.
const ffmpegScript = (encoder) => `#!/bin/sh\ncase "$*" in *-encoders*) echo " V....D ${encoder}  H.264";; esac\necho "ffmpeg version 9.9-test"\n`;
const ffprobeScript = `#!/bin/sh\necho "ffprobe version 9.9-test"\n`;

/** A zip holding one program inside folders, the way the Windows build has them. */
function zipOf(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trialpilot-zip-"));
  fs.mkdirSync(path.join(dir, "build", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build", "bin", name), body, { mode: 0o755 });
  const zip = path.join(dir, `${name}.zip`);
  execFileSync("tar", ["-a", "-cf", zip, "-C", dir, "build"]);
  return zip;
}

/** Serves zips the way the download sites do: a redirect to the file, with a .sha256 file next to it. */
async function serve(zips, { badChecksum = false } = {}) {
  const server = http.createServer((req, res) => {
    const name = path.basename(req.url);
    if (req.url.startsWith("/latest/")) {
      res.writeHead(307, { location: `/files/${name}` });
      return res.end();
    }
    const file = zips[name.replace(/\.sha256$/, "")];
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    if (!name.endsWith(".sha256")) return res.end(fs.readFileSync(file));
    const hash = badChecksum ? "0".repeat(64) : createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    res.end(`${hash}  ${name}\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/latest`;
  return { server, download: { site: "test", size_mb: 1, zips: [`${base}/ffmpeg.zip`, `${base}/ffprobe.zip`] } };
}

const installed = () => (fs.existsSync(bin) ? fs.readdirSync(bin).sort() : []);

test("a download whose checksum doesn't match is refused, and nothing is installed", { skip: scripts }, async () => {
  const { server, download } = await serve({ "ffmpeg.zip": zipOf("ffmpeg", ffmpegScript("libx264")), "ffprobe.zip": zipOf("ffprobe", ffprobeScript) }, { badChecksum: true });
  try {
    await assert.rejects(installFfmpeg(download), /checksum doesn't match/);
    assert.deepEqual(installed(), []);
  } finally {
    server.close();
  }
});

test("a build that can't make H.264 video is refused", { skip: scripts }, async () => {
  const { server, download } = await serve({ "ffmpeg.zip": zipOf("ffmpeg", ffmpegScript("libopenh264")), "ffprobe.zip": zipOf("ffprobe", ffprobeScript) });
  try {
    await assert.rejects(installFfmpeg(download), /no libx264/);
    assert.deepEqual(installed(), []);
  } finally {
    server.close();
  }
});

test("FFmpeg is downloaded, checked and put in Trialpilot's folder", { skip: scripts }, async () => {
  const { server, download } = await serve({ "ffmpeg.zip": zipOf("ffmpeg", ffmpegScript("libx264")), "ffprobe.zip": zipOf("ffprobe", ffprobeScript) });
  try {
    assert.equal(await installFfmpeg(download), "ffmpeg version 9.9-test");
    assert.deepEqual(installed(), ["ffmpeg", "ffprobe"], "the download folder is cleaned up");
    assert.match(execFileSync(path.join(bin, "ffprobe")).toString(), /ffprobe version 9\.9-test/);
  } finally {
    server.close();
  }
});
