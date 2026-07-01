# How Figmatokleftis Works

A browser extension (*Figmatokleftis* — "HTML to Figma") that captures a live webpage — layout, styles, images, text — and pastes it into a Figma canvas as editable layers. There is **no Figma plugin in this repo**: the extension only produces a payload; a Figma-side importer (not included here) decodes it. The extension's job is entirely *capture + serialize + hand off*.

## The 30-second version

1. You click the extension icon on any page.
2. A background service worker injects three scripts into the page.
3. A floating toolbar (Shadow DOM) appears with **Entire screen** / **Select element**.
4. On click, the capture engine walks the DOM, diffs every element's computed CSS against browser defaults, resolves images/fonts, infers Figma Auto Layout sizing, and serializes it all to JSON.
5. The JSON is base64-encoded, wrapped in an HTML comment marker, and written to the clipboard as `text/html`.
6. You switch to Figma, press `Ctrl/Cmd+V`, and Figma's paste handler recognizes the marker and rebuilds the tree.

## Architecture

Two layers, deliberately separated:

- **`src/lib/`** — framework-agnostic capture engine. No extension APIs, no UI. This is the whole brain.
- **`src/extension/`** — the browser shell: manifest, service worker, toolbar UI, Firefox injector.

Build: `esbuild` bundles three IIFE files per browser target — `capture.js` (from `src/lib/api.ts`), `background.js`, `toolbar.js` (+ `injector.js` for Firefox). Unminified on purpose.

## The three-world injection model

Chrome extensions run content scripts in an **ISOLATED** world that can't see the page's JS globals, but `window.figma.*` (the capture API) must live in the page's **MAIN** world. So the extension straddles three contexts:

```
MAIN world               ISOLATED world          Background (service worker)
capture.js, toolbar.js   CORS bridge             fetch() with no CORS limits
      |                        |                          |
      |-- CustomEvent -------->|                          |
      |                        |-- runtime.sendMessage -->|
      |                        |                          |-- fetch(image url)
      |                        |<-- sendResponse ---------|
      |<-- CustomEvent --------|                          |
```

- **Chrome** (`background.ts`): injects `capture.js` + `toolbar.js` directly into MAIN world via `executeScript({ world: "MAIN" })`.
- **Firefox**: can't inject into MAIN world directly, so it injects `injector.js` (ISOLATED) which creates `<script>` tags to load the MAIN-world scripts. (`injector.ts`)
- The **CORS bridge** (`installCorsBridge` in `background.ts`) is injected into ISOLATED world so page-world code can relay cross-origin image fetches to the background, which has no CORS restrictions.

## The capture pipeline (the interesting part)

Entry point: `capturePage(selector)` in [pipeline.ts](src/lib/pipeline.ts) → `captureDOM()` in [snapshot.ts](src/lib/core/snapshot.ts).

### 1. Prepare the page — `core/prepare.ts`
Before snapshotting, the engine scrolls through the entire page to trigger lazy-loaded images (`prepareForCapture`), then waits for all `<img>` to decode (`decodeImages`). Infinite-scroll pages are capped (README notes 15,000px / 25 steps) so it can't run forever.

### 2. Walk the DOM tree — `snapshotElement()` recursion
For every element, in one `requestAnimationFrame` (with a visibility-aware timeout so a backgrounded tab pauses rather than fails):

- **Visibility filter** (`walker.ts` `isNodeVisible`): skips `display:none`, `visibility:hidden`, `<script>`, and anything tagged `data-h2d-ignore="true"`. `HEAD/SCRIPT/STYLE/NOSCRIPT` are dropped outright.
- **Style diff** (`styles.ts` `diffStyles`): computes `getComputedStyle`, then keeps **only** the properties that differ from a baseline of browser defaults (`core/css-defaults.ts`). This is what keeps payloads small — it never ships the hundreds of default CSS values, only the deltas. `width`/`height` are re-checked via `computedStyleMap()` to avoid shipping a resolved pixel value when the real declared value was `auto`. Zero-width borders/outlines get their style+color stripped.
- **Flex/grid augmentation**: for flex/grid containers *and* their children, layout properties (`flexDirection`, `justifyContent`, `gridTemplateColumns`, `flexGrow`, `alignSelf`, …) are **force-included even when they match defaults**, because Figma needs them to reconstruct Auto Layout. (`ensureFlexProps` / `ensureGridProps` / `ensureFlexItemProps`)
- **Body-background propagation**: replicates the browser quirk where `<body>`'s background paints the viewport, so the Figma root frame shows the right color.
- **Transforms**: CSS transforms are read into a `DOMMatrix`, multiplied down the tree (`transform/matrix.ts`), and both the element's own matrix and its final bounding quad are stored so rotated/scaled elements land correctly.
- **Special element types**:
  - **SVG** → styles are baked inline into the SVG markup (`media/svg.ts` `bakeSvgStyles`) and stored as `content`.
  - **`<canvas>`** → rasterized to PNG, stored under a synthetic `rasterized:N` URL.
  - **Shadow DOM** → `element.shadowRoot` is traversed transparently.
- **Pseudo-elements**: `::before`, `::after` (when they have real `content`), and `::placeholder` are captured as separate style blocks.
- **Attributes**: only an allowlist survives (`alt`, `href`, `type`, `value`, `role`, `aria-*`, `data-*`, media `poster`/`currentSrc`, …) — `walker.ts` `ALLOWED_ATTRIBUTES`.
- **Text nodes**: adjacent text nodes are grouped; each gets a bounding rect + a **line count** (measured via `Range.getClientRects()` grouped by top/left) so Figma knows how many lines the text wraps to.
- **Pruning** (`shouldPruneNode`): after children are known, zero-size elements with no visible children, and elements entirely offscreen (beyond the *full document* bounds + 500px margin, not just the viewport) are dropped.

### 3. Infer Auto Layout sizing — `core/layout.ts`
For each element it guesses Figma's `FILL` / `HUG` / `FIXED` per axis (`layoutSizingHorizontal` / `Vertical`). Priority heuristics:
1. `flex-grow > 0` on the main axis → FILL
2. percentage width/height → FILL
3. "adaptive wrapper" — has `max-width` and fills ≥90% of parent, or fills ≥95% of a large parent → FILL
4. centered wrapper (`margin: 0 auto`) → FILL
5. `align-items/self: stretch` on the cross axis → FILL
6. explicit px size → FIXED
7. otherwise → HUG

Block-flow children (not inside flex/grid) get their own simpler rules (`inferBlockLayoutSizing`): plain block → FILL width, HUG height.

### 4. Resolve assets — `media/resolver.ts`
Images, `background-image` URLs, `<video>` posters/frames, and canvases are collected into a `ResourceResolver`. Each unique URL is fetched at most once. Image fetching tries strategies in order:
1. **Rasterize the already-loaded `<img>`** onto a canvas — no network, CORS-irrelevant because the browser already decoded it.
2. **`fetch()`** — works for same-origin and CORS-enabled resources.
3. **Extension CORS bridge** — for cross-origin, relay through the background worker (which has no CORS limits) and get back a base64 data URL. Once the bridge times out once, it's marked unavailable and skipped for the rest of the run.
4. Fall back to preserving just the URL with no blob.

AVIF/HEIF/HEIC (which Figma can't consume) are re-encoded to PNG via canvas.

### 5. Probe fonts — `typography/probe.ts`
Walks elements and records which font families/weights/styles are *actually rendered*, plus `@font-face` data, so Figma can request the right typefaces.

### 6. React annotations (optional) — `react/fiber.ts`, `react/tree.ts`
If enabled, it introspects the React Fiber tree and annotates captured nodes with component names and `_debugSource` file/line locations. Also reads Figma/React "source annotations" already present on instrumented elements.

## Serialization & the clipboard handoff — `encoding.ts`

- `treeToJson()` walks the capture tree and converts every asset `Blob` to a base64 data-URL object, then `JSON.stringify`s the whole thing (tree + assets + fonts).
- `wrapForClipboard()` base64-encodes that JSON and embeds it as:
  ```html
  <span data-h2d="<!--(figh2d)BASE64_PAYLOAD(/figh2d)--></span>
  ```
  written to the clipboard as a `text/html` `ClipboardItem`. The `(figh2d)…(/figh2d)` comment markers are the handshake — Figma's paste handler scans pasted HTML for them and decodes the payload. Firefox needs the clipboard write kicked off *synchronously* inside the click handler (user-activation requirement), so `toolbar.ts` opens the write with a pending `Promise<Blob>` and resolves it once capture finishes.

## The alternate path: direct submit (`submitCapture`)
Besides the clipboard route, `pipeline.ts` has `submitCapture()` which `POST`s the JSON to a Figma endpoint (`/capture/<id>/submit`) and gets back a `claimUrl`. `config.ts` allowlists which domains count as valid Figma endpoints (`figma.com`, `figdev.systems`, `localhost`, …), and `parseHashParams()` reads a `#figmacapture=<id>&figmaendpoint=<url>…` trigger from the URL. This is the server-driven capture flow (e.g. Figma opening a tab and telling it to capture) as opposed to the manual toolbar flow.

## Summary of what the JSON contains
Per `types.ts` `CaptureTree`: a root `ElementSnapshot` tree (each node: tag, allowlisted attributes, diffed styles, rect+quad, transform, layout-sizing hints, pseudo-element styles, optional SVG content / canvas placeholder, React source annotations), plus `documentRect`, `viewportRect`, `devicePixelRatio`, a `Map` of base64 assets, and a font map. That single object is everything Figma needs to rebuild the page as native layers.
