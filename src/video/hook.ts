import { chromium } from "playwright-core";
import { NoBrowserError, resolveBrowser } from "../browser.js";

export type HookStyle = "box" | "outline";
export type HookPosition = "top" | "middle" | "bottom";

export interface HookImage {
  text: string;
  style: HookStyle;
  position: HookPosition;
  width: number;
  height: number;
  file: string;
}

// Positions stay inside the part of a reel that Instagram's buttons and caption don't cover.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
body { width: 100vw; height: 100vh; position: relative; overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
#hook { position: absolute; left: 7%; right: 7%; text-align: center; font-weight: 800; line-height: 1.3; white-space: pre-line; text-wrap: balance; overflow-wrap: anywhere; }
#hook.top { top: 14%; }
#hook.middle { top: 45%; transform: translateY(-50%); }
#hook.bottom { bottom: 33%; }
#hook.box span { background: #fff; color: #000; padding: 0.1em 0.38em; border-radius: 0.22em;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
#hook.outline span { color: #fff; -webkit-text-stroke: 0.09em #000; paint-order: stroke fill; text-shadow: 0 0.04em 0.14em rgba(0, 0, 0, 0.45); }
</style></head><body><div id="hook"><span></span></div></body></html>`;

/**
 * Draws each hook line as a transparent PNG the size of the video frame. Chrome does the drawing, so
 * the system's fonts and emoji look the way they do everywhere else.
 */
export async function renderHookImages(images: HookImage[]): Promise<void> {
  if (!images.length) return;
  const found = resolveBrowser();
  if (!found) throw new NoBrowserError("No Chrome, Edge or Chromium found on this computer, and hook text is drawn with one.");
  const browser = await chromium.launch({ executablePath: found.executablePath, headless: true });
  try {
    for (const image of images) {
      const page = await browser.newPage({ viewport: { width: image.width, height: image.height }, deviceScaleFactor: 1 });
      await page.setContent(PAGE);
      await page.evaluate(({ text, style, position, width, height }) => {
        const hook = document.getElementById("hook")!;
        hook.className = `${style} ${position}`;
        // An emoji never wraps onto a line of its own.
        hook.querySelector("span")!.textContent = text.replace(/ (?=\p{Extended_Pictographic})/gu, " ");
        // Long lines shrink until the block fits in under a third of the frame.
        let size = width * 0.075;
        hook.style.fontSize = `${size}px`;
        while (size > width * 0.03 && hook.getBoundingClientRect().height > height * 0.3) {
          size *= 0.92;
          hook.style.fontSize = `${size}px`;
        }
      }, image);
      await page.screenshot({ path: image.file, type: "png", omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
