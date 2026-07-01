/**
 * Firefox-only: runs in ISOLATED world and injects capture.js + toolbar.js
 * into MAIN world via <script> tags.
 *
 * Chrome uses scripting.executeScript({ world: "MAIN" }) directly, but
 * Firefox does not support the `world` parameter in scripting.executeScript.
 */

function injectScript(file: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = browser.runtime.getURL(file);
    s.onload = () => {
      s.remove();
      resolve();
    };
    s.onerror = () => {
      s.remove();
      reject(new Error(`Failed to inject ${file}`));
    };
    (document.head || document.documentElement).appendChild(s);
  });
}

(async () => {
  try {
    await injectScript("capture.js");
    await injectScript("toolbar.js");
  } catch (e) {
    console.error("Figmatokleftis: failed to inject scripts", e);
  }
})();
