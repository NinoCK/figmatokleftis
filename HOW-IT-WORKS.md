# How Figmatokleftis Works

Figmatokleftis is a browser extension that captures a live webpage and serializes it into a format Figma can paste as editable layers. The user clicks the extension icon, picks a capture mode from a floating toolbar, and the result lands on the clipboard. In Figma, `Ctrl+V` / `Cmd+V` reconstructs the page as frames, text, images, and layout.

The codebase splits into two layers:

| Layer | Location | Role |
|-------|----------|------|
| **Capture library** | `src/lib/` | Framework-agnostic DOM processing engine |
| **Extension shell** | `src/extension/` | Script injection, CORS bridge, toolbar UI |

esbuild bundles both into IIFE scripts under `dist/chrome/` and `dist/firefox/`.

---

## End-to-end flow

```
User clicks extension icon
        │
        ▼
background.ts (service worker)
  ├─ inject CORS bridge into ISOLATED world
  └─ inject capture.js + toolbar.js into MAIN world
        │
        ▼
toolbar.ts shows floating panel (Shadow DOM)
  ├─ Entire screen  → capturePage("body")
  ├─ Select element → hover + click, capturePage("#tempId")
  ├─ Capture in 3s  → countdown, then capturePage("body", { skipLazyScroll: true })
  └─ Ctrl/Cmd+Shift+S → instant capture with skipLazyScroll
        │
        ▼
pipeline.ts → capturePage()
  ├─ wait for DOM ready
  ├─ snapshot.ts → captureDOM()  (walk DOM, collect assets/fonts)
  ├─ encoding.ts → treeToJson()  (assets → base64)
  └─ encoding.ts → wrapForClipboard() → navigator.clipboard.write()
        │
        ▼
User pastes into Figma canvas
```

---

## Extension shell

### Background service worker (`background.ts`)

When the user clicks the extension icon, the background worker:

1. **Guards unsupported pages** — skips `chrome://`, `about:`, extension pages, and warns on `file://` if file access is not enabled.
2. **Installs the CORS bridge** — runs `installCorsBridge()` in the page's **ISOLATED** content-script world (the default for `scripting.executeScript` without a `world` parameter).
3. **Injects capture scripts** into the page's **MAIN** world (same realm as the page's own JavaScript):
   - **Chrome**: `scripting.executeScript({ world: "MAIN", files: [...] })` directly.
   - **Firefox**: injects `injector.js` (ISOLATED), which creates `<script>` tags pointing at `capture.js` and `toolbar.js` (web-accessible resources). Firefox does not support the `world` parameter.

The background worker also handles `figma-capture-fetch-image` messages: it fetches image URLs without CORS restrictions and returns base64 data URLs.

### CORS bridge (ISOLATED ↔ MAIN ↔ background)

Cross-origin images cannot be read from the page's MAIN world. The bridge solves this:

```
MAIN world (capture.js)
  │  CustomEvent "figma-capture-fetch" { url, callbackId }
  ▼
ISOLATED world (installCorsBridge)
  │  chrome.runtime.sendMessage({ type: "figma-capture-fetch-image", url })
  ▼
background.ts
  │  fetch(url) → base64 data URL
  ▼
ISOLATED world
  │  CustomEvent "figma-capture-fetch-result" { callbackId, result }
  ▼
MAIN world → Blob
```

If the bridge times out once, it is marked unavailable for the rest of the capture to avoid per-image 1.5s delays.

### Toolbar UI (`toolbar.ts`)

A self-contained IIFE that:

- Mounts a **closed Shadow DOM** host (`#__figma_capture_ext_toolbar__`) so page CSS cannot leak in or out.
- Offers three capture modes plus keyboard shortcuts.
- Calls `window.figma.capturePage()` and `window.figma.writeToClipboard()` exposed by `api.ts`.
- **Firefox clipboard workaround**: `navigator.clipboard.write()` requires user activation. Firefox creates a `ClipboardItem` with a pending `Promise<Blob>` at click time (before any `await`), keeping the write transaction open until capture finishes.
- **Delayed / hotkey capture** passes `{ skipLazyScroll: true }` so open dropdowns and menus are not dismissed by the page scroll-through that triggers lazy-loaded images.

---

## Capture library

### Public API (`api.ts`)

`capture.js` is the library entry point. It attaches functions to `window.figma`:

| Function | Purpose |
|----------|---------|
| `capturePage(selector?, options?)` | Full capture pipeline → JSON string |
| `writeToClipboard(json)` | Wrap and copy to clipboard |
| `wrapForClipboard(json)` | Produce the HTML blob Figma expects |
| `submitCapture(json, id, endpoint)` | POST to Figma's capture API (used by hash-param automation, not the toolbar) |
| `parseHashParams()` | Read `#figmacapture=...` URL hash for automated captures |
| `setVerbose(bool)` | Toggle debug logging |

### Pipeline (`pipeline.ts`)

`capturePage()` orchestrates:

1. **DOM ready wait** — blocks on `DOMContentLoaded` if needed.
2. **Root resolution** — `"body"` / `"html"` → `document`; otherwise `querySelector`.
3. **DOM capture** — `captureDOM()` with a 10s visibility-aware timeout (pauses while the tab is hidden).
4. **JSON serialization** — `treeToJson()` converts asset blobs to base64.
5. **Clipboard write** — `wrapForClipboard()` embeds the JSON in an HTML comment marker, written as `text/html`.

`submitCapture()` is a separate path for posting directly to a Figma endpoint (used when the page URL contains `#figmacapture=...` hash parameters).

### DOM snapshot engine (`core/snapshot.ts`)

`captureDOM()` is the heart of the library. It:

1. Validates layout (`prepare.ts`).
2. Creates a `ResourceResolver` (images/videos/canvases) and `TypefaceProbe` (fonts).
3. Prepares the page, walks the DOM inside `requestAnimationFrame`, then resolves all assets.

#### Preparation (`core/prepare.ts`)

Before walking the tree:

- **Force lazy images** — rewrites `data-src`, `data-srcset`, `loading="lazy"`, `<picture>` sources, and `data-bg` attributes.
- **Scroll-through** (unless `skipLazyScroll`) — scrolls the page in steps (max 15 000 px, 25 steps) to trigger `IntersectionObserver`-based lazy loaders, then scrolls back to top.
- **Hide scrollbars** — injects CSS so scrollbar width does not shrink the viewport.
- **Decode images** — sets `decoding="sync"` and awaits `img.decode()`.

When `skipLazyScroll` is true (delayed capture), the page is left at its current scroll position and coordinates are shifted by `(scrollX, scrollY)` so rects stay in document space.

#### Tree walk (`snapshotElement` / `snapshotTextNode`)

For each visible element:

| Step | Module | What happens |
|------|--------|--------------|
| Visibility filter | `walker.ts` | Skip `display:none`, `visibility:hidden`, `data-h2d-ignore` |
| Style diff | `styles.ts` | Compare computed style against `css-defaults.ts` baseline; only non-default values are kept |
| Flex/grid augmentation | `styles.ts` | Force-include layout properties Figma needs even when they match defaults |
| Transform | `matrix.ts` | Build combined `DOMMatrix`, compute rotated quads |
| Special elements | various | SVG → inline with baked styles; Canvas → rasterize; iframe → descend |
| Pseudo-elements | `snapshot.ts` | `::before`/`::after` as styles or synthesized child nodes; `::placeholder` for inputs |
| Assets | `resolver.ts` | Collect `<img>`, `<video>`, `background-image` URLs |
| Fonts | `probe.ts` | Record font family/weight/style/size usage |
| Layout hints | `layout.ts` | Infer `FILL` / `HUG` / `FIXED` for Auto Layout |
| Pruning | `walker.ts` | Remove zero-size, offscreen, and empty containers |

**Realm safety**: elements inside same-origin iframes use that iframe's `window` constructors (`view.SVGElement`, `view.HTMLCanvasElement`, etc.) so `instanceof` checks work correctly.

**Same-origin iframes**: `snapshotIframe()` reads `iframe.contentDocument`, offsets all child coordinates by the iframe's on-page position (content box), and recurses into `documentElement`. Cross-origin iframes are inaccessible and captured as empty boxes.

**Shadow DOM**: children are read from `element.shadowRoot ?? element`.

#### Output shape (`types.ts`)

Each element becomes an `ElementSnapshot`:

```ts
{
  nodeType: 1,
  id: "h2d-node-N",
  tag: "DIV",
  attributes: { ... },
  styles: { /* diffed CSS */ },
  rect: { x, y, width, height, cssWidth, cssHeight, quad? },
  childNodes: [...],
  layoutSizingHorizontal: "FILL" | "HUG" | "FIXED",
  layoutSizingVertical: "FILL" | "HUG" | "FIXED",
  content?: string,          // inline SVG markup
  placeholderUrl?: string,  // canvas/video raster key
  pseudoElementStyles?: { before?, after?, placeholder? },
  relativeTransform?: { a, b, c, d, e, f },
  ...
}
```

Text nodes become `TextSnapshot` with measured bounding rect and line count.

The top-level `CaptureTree` wraps the root element with metadata: document/viewport rects, `devicePixelRatio`, `assets` map, and `fonts` map.

---

## Key subsystems

### Style diffing (`core/styles.ts` + `core/css-defaults.ts`)

`BASELINE_STYLES` is a large table of browser-default computed values (generated from Chrome). `diffStyles()` compares an element's computed style property-by-property and keeps only deviations. This keeps the payload small.

Special rules:

- `width`/`height` use `computedStyleMap()` to avoid false diffs when the resolved value is `auto`.
- Zero-width borders and outlines strip their style/color.
- Flex/grid containers and children always get their layout properties included.

### Auto Layout sizing (`core/layout.ts`)

`inferLayoutSizing()` maps CSS layout behavior to Figma's `FILL` / `HUG` / `FIXED`:

- Flex children: `flexGrow > 0` → FILL on main axis; `align-items: stretch` → FILL on cross axis; percentage widths → FILL; explicit pixels → FIXED; otherwise HUG.
- Block children: no explicit width → FILL; centered wrappers (`margin: auto` + `max-width`) → FILL.
- "Adaptive wrapper" heuristic: elements filling ≥95% of parent or centered with max-width constraints.

### Asset resolution (`media/resolver.ts`)

During the DOM walk, `resolveResources()` registers image/video/background URLs. After the walk, `getBlobMap()` fetches them with **bounded concurrency** (6 at a time) to avoid flooding disk I/O.

Fetch strategies (in order):

| # | Strategy | When |
|---|----------|------|
| 1 | Canvas rasterize existing `<img>` | Same-origin; browser already decoded the image |
| 2 | `fetch(url)` | Same-origin or CORS-enabled |
| 3 | Extension CORS bridge | Cross-origin; background fetches without CORS |
| 4 | Rasterize any loaded `<img>` on page | Fallback when bridge unavailable |
| 5 | URL only, no blob | Cross-origin with no working strategy |

Canvases are rasterized to PNG under synthetic `rasterized:N` URLs. Videos capture the current frame (or poster). AVIF/HEIF/HEIC are re-encoded to PNG via canvas.

### SVG inlining (`media/svg.ts`)

`bakeSvgStyles()` clones an SVG subtree and inlines every computed style that differs from SVG defaults as attributes, producing self-contained markup stored in `content`.

### Transform math (`transform/matrix.ts`)

`resolveTransform()` parses CSS `transform` and individual transform properties into a `DOMMatrix`. Parent and child matrices are multiplied. `getElementRect()` returns axis-aligned bounds plus an optional rotated `quad` for non-trivial transforms.

### Font detection (`typography/probe.ts`)

`TypefaceProbe` walks elements, parses `font-family` stacks, and uses an off-screen canvas to compare glyph widths against generic fallbacks — determining which families are actually rendered. Usage records (weight, style, stretch, size) are deduplicated per family.

### React integration (`react/fiber.ts`, `react/tree.ts`)

Optional (off by default):

- Reads `data-fg-*` source annotations from Figma Dev Mode instrumentation.
- Walks React Fiber trees to attach component names and serialize props.
- Enabled via `includeReactFiberTree: true` in capture options.

### Declared styles (`core/declared.ts`)

Optional (`captureDeclaredStyles: true`): scans document stylesheets for flex/grid rules and matches them to elements, providing authored CSS values alongside computed ones.

---

## Encoding and clipboard format (`encoding.ts`)

1. **`treeToJson()`** — serializes the `CaptureTree` to JSON. Each asset blob is converted to `{ type, base64Blob }` (a data URL). Raw blobs are nulled after encoding to limit peak memory.

2. **`wrapForClipboard()`** — base64-encodes the JSON string and wraps it in HTML:

   ```html
   <span data-h2d="<!--(figh2d)BASE64_PAYLOAD(/figh2d)-->"></span>
   ```

   Figma's paste handler recognizes the `(figh2d)` markers and decodes the payload.

---

## Build system (`esbuild.config.mjs`)

| Output | Entry | Purpose |
|--------|-------|---------|
| `capture.js` | `src/lib/api.ts` | Capture library (MAIN world) |
| `background.js` | `src/extension/background.ts` | Service worker |
| `toolbar.js` | `src/extension/toolbar.ts` | Toolbar UI (MAIN world) |
| `injector.js` | `src/extension/injector.ts` | Firefox MAIN-world loader (firefox only) |

All bundles are IIFE format, ES2020 target, unminified. Static assets and manifests are copied to `dist/chrome/` and `dist/firefox/`. The Firefox manifest adds `web_accessible_resources` for script injection and uses `background.scripts` instead of a service worker.

---

## Configuration and automation

### Hash parameters (`config.ts`)

Pages can trigger automated capture via URL hash:

```
#figmacapture=<id>&figmaendpoint=<url>&figmadelay=<ms>&figmaselector=<sel>
```

`parseHashParams()` reads these. Combined with `submitCapture()`, this supports Figma-driven capture workflows without the toolbar.

### Capture options (`types.ts`)

| Option | Default | Effect |
|--------|---------|--------|
| `assertLayoutValid` | `true` | Throw if body has zero rect |
| `skipRemoteAssetSerialization` | `false` | Skip fetching remote image blobs |
| `includeReactFiberTree` | `false` | Attach React component tree |
| `captureDeclaredStyles` | `false` | Include authored stylesheet rules |
| `skipLazyScroll` | `false` | Skip scroll-through (preserve open menus) |
| `timeoutSignal` | 10s abort | Cancel capture if tab hangs |

---

## Browser differences

| Concern | Chrome | Firefox |
|---------|--------|---------|
| MAIN world injection | `world: "MAIN"` in `executeScript` | `injector.js` + `<script>` tags |
| Background | Service worker | Background scripts array |
| Clipboard write | Standard `writeToClipboard()` | Pending `ClipboardItem` at click time |
| File URL access | `isAllowedFileSchemeAccess()` check | No equivalent check |

---

## Project layout

```
src/
├── lib/                    # Capture library
│   ├── api.ts              # window.figma public API
│   ├── pipeline.ts         # capturePage / submitCapture / clipboard
│   ├── encoding.ts         # JSON + clipboard wrapping
│   ├── config.ts           # Endpoint validation, hash params
│   ├── types.ts            # Shared type definitions
│   ├── core/
│   │   ├── snapshot.ts     # DOM walk orchestrator
│   │   ├── prepare.ts      # Lazy loading, scrollbars, layout check
│   │   ├── walker.ts       # Visibility, attributes, text measurement
│   │   ├── styles.ts       # Style diffing, flex/grid augmentation
│   │   ├── layout.ts       # Auto Layout sizing inference
│   │   ├── declared.ts     # Stylesheet rule matching
│   │   └── css-defaults.ts # Browser baseline computed values
│   ├── media/
│   │   ├── resolver.ts     # Image/video/canvas asset fetching
│   │   └── svg.ts          # SVG style baking
│   ├── transform/
│   │   └── matrix.ts       # CSS transform parsing and rects
│   ├── typography/
│   │   └── probe.ts        # Font availability detection
│   └── react/
│       ├── fiber.ts        # React Fiber + Figma annotations
│       └── tree.ts         # Component tree serialization
├── extension/              # Browser extension shell
│   ├── background.ts       # Injection + CORS bridge + image fetch
│   ├── toolbar.ts          # Shadow DOM capture UI
│   ├── injector.ts         # Firefox MAIN-world script loader
│   ├── manifest.json       # Chrome MV3 manifest
│   └── manifest.firefox.json
└── assets/                 # Extension icons
```

---

## Error handling

- `CaptureError` codes (`PAGE_NOT_RESPONDING`, `CAPTURE_EXPIRED`, etc.) map to user-facing messages in `pipeline.ts`.
- Asset fetch failures produce `{ url, blob: null, error }` entries rather than aborting the whole capture.
- Image decode failures are logged at debug level and skipped.
- The toolbar shows status text for capture progress, success, and errors; a Stop button appears after 5 seconds for long captures.
