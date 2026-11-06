# Trialpilot

Test a video before everyone sees it. Trialpilot turns one video into a few lightly edited versions and posts each one as an Instagram trial reel from your own signed-in browser. Trial reels are shown to people who don't follow you yet, so you see which version works before your followers see any of them.

Trialpilot is free and open source. It runs on your computer and works through instagram.com in a browser window, with one saved sign-in per account. It does not use an official Instagram API, and automating instagram.com is against Instagram's terms, so you use it at your own risk. Nothing is posted without your approval of the exact versions, captions and times.

## What it does

- **Makes versions.** Up to 5 versions of one video, each changing one thing: a hook line over the first seconds, a different opening, speed, zoom, colour and grain, mirroring, or music you have the rights to. Each comes with a strip of frames for comparing them at a glance, and every file is checked to be one Instagram accepts. HDR videos, which most iPhones record, come out in normal colour, so they don't look dark and grey on Instagram.
- **Posts them as trial reels.** You see every version with its caption and time, and nothing goes out until you say yes. Trialpilot posts one every 30 minutes (you can change that), at most 5 a day per account, through instagram.com's own New post window: the video, the caption (read back before Share), sharing to Facebook and Threads off, and the trial setting. The publish request is checked on its way out, and if it doesn't carry the trial setting, it's stopped.
- **Checks every reel.** After each one, Trialpilot looks at the new reel: a trial reel is marked as one and stays off your profile grid. If one goes out as a normal reel, or can't be confirmed, Trialpilot stops trial posting on that account and shows a notification until you've checked it.
- **Tries it first.** A test run goes through every step, Share included, and stops the publish request, so nothing is posted.
- **Connects accounts.** A browser window opens on Instagram's sign-in page and you sign in yourself. Trialpilot never sees your password.
- **Gets FFmpeg.** Making versions needs FFmpeg. If your computer doesn't have it, Trialpilot downloads it once after you say yes, from ffmpeg.martin-riedl.de on a Mac or gyan.dev on Windows. FFmpeg is GPL software and isn't included in Trialpilot.

Trialpilot posts each version itself at its time, so Claude Desktop has to stay open until the last one has gone out.

**Coming next:** comparing views, likes, comments and shares after about a day, and sharing the winner with all your followers.

## Try it

```bash
npm install
npm run pack:mcpb   # builds build/trialpilot.mcpb; double-click it to add it to Claude Desktop
```

Then ask Claude "Connect my Instagram", "Make 3 versions of clip.mp4 with different hooks", then "Post them as trial reels on @myaccount". A video can be a full path or a file in `~/Trialpilot/videos`.

## Developer scripts

```bash
npm install && npm run build
node scripts/connect.mjs                           # sign in to an account in a new window
node scripts/inspect-trial.mjs <username> <video>  # what instagram.com offers it for trial reels; posts nothing
node scripts/make-versions.mjs <video> <versions.json>
npm test
```
