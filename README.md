# Trialpilot

Test a video before everyone sees it. Trialpilot turns one video into a few lightly edited versions, posts each one as an Instagram trial reel from your own signed-in browser, and after about a day shows which version did best, so you can share the winner with everyone.

**Work in progress: nothing here is ready to use yet.**

Trialpilot is free and open source. It runs on your computer and works through instagram.com in a browser window, with one saved sign-in per account. It does not use an official Instagram API, and automating instagram.com is against Instagram's terms, so you use it at your own risk. Nothing is posted without your approval of the exact versions, captions and times.

## Developer scripts

```bash
npm install && npm run build
node scripts/connect.mjs                           # sign in to an account in a new window
node scripts/inspect-trial.mjs <username> <video>  # what instagram.com offers it for trial reels; posts nothing
```
