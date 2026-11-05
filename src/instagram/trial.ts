import type { Page, Response } from "playwright-core";

/** What instagram.com's own responses said about trial reels for the signed-in account. */
export interface TrialSignals {
  /**
   * xig_fetch_user.trial_clips_enabled. The website's long-form uploader reads it with
   * usePolarisLongFormCreationEligibilityQuery and shows "Enable trial reel" only when it is true
   * and the account is public.
   */
  trial_clips_enabled?: boolean;
  is_private?: boolean;
  /** The request whose response carried trial_clips_enabled. */
  source?: string;
  /** Codes of posts those responses marked is_trial_reel. */
  trial_media: string[];
}

function operationName(response: Response): string | undefined {
  const request = response.request();
  return request.headers()["x-fb-friendly-name"] ?? request.postData()?.match(/fb_api_req_friendly_name=([^&]+)/)?.[1];
}

// GraphQL answers can carry a "for (;;);" guard or several JSON objects, one per line.
function jsonChunks(body: string): unknown[] {
  const text = body.replace(/^for \(;;\);/, "").trim();
  try {
    return [JSON.parse(text)];
  } catch {
    return text.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
}

/** Listens to what instagram.com fetches for itself and notes the trial reel fields. Sends no requests of its own. */
export function watchTrialSignals(page: Page): TrialSignals {
  const signals: TrialSignals = { trial_media: [] };

  const walk = (node: any, source: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, source);
      return;
    }
    if (typeof node.trial_clips_enabled === "boolean") {
      signals.trial_clips_enabled = node.trial_clips_enabled;
      if (typeof node.is_private === "boolean") signals.is_private = node.is_private;
      signals.source = source;
    }
    if (node.is_trial_reel === true && typeof node.code === "string" && !signals.trial_media.includes(node.code)) {
      signals.trial_media.push(node.code);
    }
    for (const value of Object.values(node)) walk(value, source);
  };

  page.on("response", async (response) => {
    const url = response.url();
    if (!/instagram\.com\/(graphql|api\/graphql|api\/v1\/)/.test(url)) return;
    try {
      const body = await response.text();
      if (!body.includes("trial")) return;
      const source = operationName(response) ?? new URL(url).pathname;
      for (const chunk of jsonChunks(body)) walk(chunk, source);
    } catch {
      // responses that aren't JSON, or that finish after the window closes
    }
  });
  return signals;
}
