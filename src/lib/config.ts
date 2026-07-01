/**
 * Endpoint validation and hash parameter parsing.
 */

import type { HashParams } from './types.js';

// Domains that are considered valid Figma endpoints
export const ALLOWED_FIGMA_DOMAINS: string[] = [
  "figma.com",
  "www.figma.com",
  "api.figma.com",
  "mcp.figma.com",
  "local.figma.engineering",
  "mcp.local.figma.engineering",
  "figdev.systems",
  "localhost",
];

/**
 * Check whether a URL points to a recognised Figma domain.
 * Returns false for malformed URLs rather than throwing.
 */
export function isValidFigmaEndpoint(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_FIGMA_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Parse `window.location.hash` for figmacapture parameters.
 *
 * Expected format:
 *   #figmacapture=<id>&figmaendpoint=<url>&figmadelay=<ms>
 *     &figmaselector=<sel>&figmalogpayload=<bool>&figmalogverbose=<bool>
 *
 * Returns an object whose `shouldCapture` flag indicates whether the
 * hash contained a figmacapture trigger.
 */
export function parseHashParams(): HashParams {
  const hash = window.location.hash;

  if (!hash.startsWith("#figmacapture")) {
    return { shouldCapture: false };
  }

  const parts = hash.slice(1).split("&");

  let captureId: string | undefined;
  let endpoint: string | undefined;
  let delay: number | undefined;
  let selector: string | undefined;
  let logPayload: boolean | undefined;
  let logVerbose: boolean | undefined;

  for (const part of parts) {
    const [key, value] = part.split("=");

    if (key === "figmacapture" && value) {
      captureId = decodeURIComponent(value);
    } else if (key === "figmaendpoint" && value) {
      endpoint = decodeURIComponent(value);
    } else if (key === "figmadelay" && value) {
      const parsed = parseInt(decodeURIComponent(value), 10);
      if (!isNaN(parsed) && parsed >= 0) {
        delay = parsed;
      }
    } else if (key === "figmaselector" && value) {
      selector = decodeURIComponent(value);
    } else if (key === "figmalogpayload") {
      logPayload = value !== "false";
    } else if (key === "figmalogverbose") {
      logVerbose = value !== "false";
    }
  }

  return {
    shouldCapture: true,
    captureId,
    endpoint,
    delay,
    selector,
    logPayload,
    logVerbose,
  };
}
