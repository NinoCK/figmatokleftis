# Figmatokleftis

Browser extension that captures any webpage and lets you paste it directly into a Figma canvas — preserving layout, styles, images, and text as editable Figma layers.

**HTML to Figma, one click away.**

## How it works

1. Click the extension icon on any webpage
2. Choose **Entire screen**, **Select element**, or **Capture in 3s** (gives you time to open a dropdown/menu first)
3. The page is captured to your clipboard
4. Switch to Figma and press `Ctrl+V` / `Cmd+V` — done

The extension walks the DOM tree, computes a style diff against browser defaults, resolves images (including cross-origin), infers Auto Layout sizing hints, and serializes everything into Figma's clipboard format.

## Features

- **Full-page capture** — captures the entire scrollable page, not just the viewport
- **Element selection** — pick a specific component to capture
- **Delayed capture** — "Capture in 3s" lets you open a dropdown/menu before the snapshot fires
- **Same-origin iframe capture** — descends into iframes (e.g. embedded charts) and places their content at the correct coordinates
- **Realm-safe element handling** — SVGs, canvases, images and form controls inside iframes are captured correctly
- **Auto Layout hints** — infers FILL / HUG / FIXED sizing for every element
- **Flex & grid support** — preserves flex direction, alignment, gap, and grid structure
- **Cross-origin images** — multi-strategy fetch with a CORS bridge through the background service worker, run with bounded concurrency to keep disk I/O in check
- **SVG inlining** — computed styles are baked into SVG elements for accurate rendering
- **Font detection** — probes which fonts are actually rendered on the page
- **Lazy image loading** — forces lazy images to load before capture

## Install

### Chrome / Edge / Brave / Arc

1. Download the latest `figmatokleftis-chrome-vX.X.X.zip` from [Releases](../../releases) (or build from source below)
2. Unzip it
3. Go to `chrome://extensions` and enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder (or `dist/chrome/`)

### Firefox

1. Download the latest `figmatokleftis-firefox-vX.X.X.zip` from [Releases](../../releases)
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** and select the zip file

### Build from source

```sh
git clone https://github.com/NinoCK/figmatokleftis.git
cd figmatokleftis
npm install
npm run build
```

Load `dist/chrome/` or `dist/firefox/` as described above.

## Architecture

Two layers:

- **Capture library (`src/lib/`)** — framework-agnostic DOM processing engine. DOM walking, CSS style diffing, layout sizing inference, image/font resolution, SVG inlining, transform math, same-origin iframe descent, JSON serialization and clipboard encoding.
- **Extension shell (`src/extension/`)** — Manifest V3 service worker (script injection + CORS bridge for cross-origin images) and a Shadow DOM toolbar UI.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Bundle to `dist/{chrome,firefox}` |
| `npm run build:zip` | Build + create zip archives |
| `npm run watch` | Rebuild on file changes |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |

## Tech stack

- **TypeScript** — strict mode, ES2020 target
- **esbuild** — fast bundling, IIFE output (unminified for readability)

## Local files

To capture local HTML files (`file://` URLs), enable file access: `chrome://extensions` → Figmatokleftis → Details → toggle "Allow access to file URLs".
