import type { Locator, Page } from "playwright-core";
import { labels } from "./labels.js";

export async function clickIfVisible(locator: Locator): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click().catch(() => {});
  await locator.page().waitForTimeout(1200);
  return true;
}

export async function openNewPost(page: Page): Promise<Locator | null> {
  const dialogInput = page.locator('div[role="dialog"] input[type="file"]');
  const triggers = [
    ...labels.newPostIcon.map((name) => page.locator(`svg[aria-label="${name}"]`).first()),
    page.getByRole("link", { name: labels.create }).first(),
    page.getByRole("button", { name: labels.create }).first(),
  ];
  for (const trigger of triggers) {
    if (!(await clickIfVisible(trigger))) continue;
    // Newer layouts open a small menu (Post, Live video, Ad) before the upload window.
    const postItem = page
      .locator('svg[aria-label="Post"]')
      .or(page.getByRole("menuitem", { name: labels.postMenuItem }))
      .or(page.getByRole("link", { name: labels.postMenuItem }))
      .first();
    await clickIfVisible(postItem);
    if ((await dialogInput.count()) > 0) return dialogInput.first();
  }
  const anyInput = page.locator('input[type="file"][accept*="image"], input[type="file"][accept*="video"]');
  return (await anyInput.count()) > 0 ? anyInput.first() : null;
}

// Crop and Edit come before the caption step; each has a Next button. A video needs a
// few seconds of processing before Next responds, so keep trying until the deadline.
export async function advanceToCaption(page: Page, timeoutMs = 60_000): Promise<Locator | null> {
  const dialog = page.locator('div[role="dialog"]');
  const captionBox = dialog.locator('div[contenteditable="true"]').first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await captionBox.isVisible().catch(() => false)) return captionBox;
    await clickIfVisible(dialog.getByRole("button", { name: labels.next }).first());
    await page.waitForTimeout(1500);
  }
  return null;
}

/** Every switch in the New post window with the text of the row it sits in. */
export async function switchRows(page: Page): Promise<Array<{ toggle: Locator; text: string }>> {
  const all = page.locator('div[role="dialog"]').locator('input[role="switch"], input[type="checkbox"]');
  const rows = [];
  for (let i = 0; i < (await all.count()); i++) {
    const toggle = all.nth(i);
    const text = await toggle.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      for (let k = 0; k < 8 && node; k++) {
        node = node.parentElement;
        const found = node?.innerText?.trim() ?? "";
        if (found.length > 2) return found;
      }
      return "";
    });
    rows.push({ toggle, text });
  }
  return rows;
}
