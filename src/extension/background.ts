const isFirefox =
  typeof browser !== "undefined" &&
  typeof browser.runtime !== "undefined" &&
  typeof (browser.runtime as unknown as Record<string, unknown>).getBrowserInfo === "function";
const api = typeof browser !== "undefined" ? browser : chrome;

api.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Check for unsupported pages (chrome://, file:// without permission, etc.)
  const url = tab.url || "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("moz-extension://")
  ) {
    // Can't inject into browser internal pages
    return;
  }

  if (url.startsWith("file://")) {
    // chrome.extension.isAllowedFileSchemeAccess is Chrome-only
    if (!isFirefox) {
      const hasFileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!hasFileAccess) {
        await api.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            alert(
              "Figmatokleftis: To use on local files, enable \"Allow access to file URLs\" in extension settings.\n\n" +
              "Go to chrome://extensions → Figmatokleftis → Details → toggle \"Allow access to file URLs\"",
            );
          },
        }).catch(() => {
          // Even the alert might fail — nothing we can do
        });
        return;
      }
    }
  }

  try {
    // Inject the CORS-bypass bridge into the ISOLATED world first,
    // so the content script can relay fetch requests from MAIN world.
    // ISOLATED is the default world — omitting `world` works on both browsers.
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: installCorsBridge,
    });

    if (isFirefox) {
      // Firefox: inject injector.js (ISOLATED world) which creates <script>
      // tags to load capture.js + toolbar.js into MAIN world.
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["injector.js"],
      });
    } else {
      // Chrome: direct MAIN world injection
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN" as chrome.scripting.ExecutionWorld,
        files: ["capture.js"],
      });

      await api.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN" as chrome.scripting.ExecutionWorld,
        files: ["toolbar.js"],
      });
    }
  } catch (e) {
    console.error("Figmatokleftis: cannot inject on this page", e);
  }
});

// ---------------------------------------------------------------------------
// Cross-origin image fetch (background has no CORS limits)
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "figma-capture-fetch-image") {
    fetchImageAsBase64(message.url)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }

  return false;
});

/**
 * Fetch an image URL from the background (no CORS restrictions) and return
 * it as a base64 data URL.
 */
async function fetchImageAsBase64(url: string): Promise<{ dataUrl: string } | { error: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:${blob.type || "image/png"};base64,${base64}`;
    return { dataUrl };
  } catch (err) {
    return { error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// CORS bridge (injected into ISOLATED world of the content page)
// ---------------------------------------------------------------------------

/**
 * This function runs in the ISOLATED content script world. It listens for
 * custom events from the MAIN world (where capture.js runs) and relays
 * them to the background via chrome.runtime.sendMessage.
 *
 * Flow: MAIN world → CustomEvent → ISOLATED world → chrome.runtime.sendMessage → background fetch
 */
function installCorsBridge(): void {
  if ((window as unknown as Record<string, boolean>).__figmaCorsBridge) return;
  (window as unknown as Record<string, boolean>).__figmaCorsBridge = true;

  // Use whichever API is available (Firefox: browser.*, Chrome: chrome.*)
  const rt = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;

  // CORS image fetch bridge
  window.addEventListener("figma-capture-fetch", async (event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail?.url || !detail?.callbackId) return;

    try {
      const result = await rt.sendMessage({
        type: "figma-capture-fetch-image",
        url: detail.url,
      });

      window.dispatchEvent(
        new CustomEvent("figma-capture-fetch-result", {
          detail: { callbackId: detail.callbackId, result },
        }),
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("figma-capture-fetch-result", {
          detail: {
            callbackId: detail.callbackId,
            result: { error: String(err) },
          },
        }),
      );
    }
  });

}
