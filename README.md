# Trialpilot

Test a video before everyone sees it. Trialpilot turns one video into a few lightly edited versions, posts each one as an Instagram trial reel from your own signed-in browser, and after about a day shows which version did best, so you can share the winner with everyone.

**Work in progress.** It can connect accounts and make the versions; posting them as trial reels isn't built yet.

Trialpilot is free and open source. It runs on your computer and works through instagram.com in a browser window, with one saved sign-in per account. It does not use an official Instagram API, and automating instagram.com is against Instagram's terms, so you use it at your own risk. Nothing is posted without your approval of the exact versions, captions and times.

## What works so far

- **Connect accounts.** A browser window opens on Instagram's sign-in page and you sign in yourself. Trialpilot never sees your password.
- **Make versions.** Up to 5 versions of one video, each changing one thing: a hook line over the first seconds, a different opening, speed, zoom, colour and grain, mirroring, or music you have the rights to. Each comes with a strip of frames for comparing them at a glance, and every file is checked to be one Instagram accepts. HDR videos, which most iPhones record, come out in normal colour, so they don't look dark and grey on Instagram.
- **FFmpeg.** Making versions needs FFmpeg. If your computer doesn't have it, Trialpilot downloads it once after you say yes, from ffmpeg.martin-riedl.de on a Mac or gyan.dev on Windows. FFmpeg is GPL software and isn't included in Trialpilot.

## Try it

```bash
npm install
npm run pack:mcpb   # builds build/trialpilot.mcpb; double-click it to add it to Claude Desktop
```

Then ask Claude "Connect my Instagram", or "Make 3 versions of clip.mp4 with different hooks". A video can be a full path or a file in `~/Trialpilot/videos`.

## Developer scripts

```bash
npm install && npm run build
node scripts/connect.mjs                           # sign in to an account in a new window
node scripts/inspect-trial.mjs <username> <video>  # what instagram.com offers it for trial reels; posts nothing
node scripts/make-versions.mjs <video> <versions.json>
npm test
```
