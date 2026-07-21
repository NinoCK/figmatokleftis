# How Figmatokleftis Captures HTML Elements

This document explains the element-capture engine in `src/lib/` — how a live DOM
tree is turned into the snapshot Figma pastes as editable layers — and which
elements our version captures that the stock capture misses.

For the full system overview (extension shell, clipboard format, build), see
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).

---

## The core idea

The engine never parses HTML source. It reads the **live, rendered DOM**: for
every element it asks the browser two questions —

1. **Where is it?** `getBoundingClientRect()` (plus transform math) gives exact
   pixel geometry.
2. **What does it look like?** `getComputedStyle()` gives the final CSS the
   browser actually applied, after every stylesheet, media query, and inline
   style has been resolved.

Because it reads computed results instead of source code, the capture works the
same on React, Vue, plain HTML, or anything else — the framework has already
done its job by the time we look.

---

## Step 1 — Prepare the page (`core/prepare.ts`)

A page as-loaded hides a lot of content. Before walking the tree:

- **Lazy images are forced**: `data-src`, `data-srcset`, `loading="lazy"`,
  `<picture>` sources, and `data-bg` attributes are rewritten so the browser
  loads them now.
- **Scroll-through**: the page is scrolled in steps (up to 15 000 px, 25 steps)
  to fire `IntersectionObserver`-based lazy loaders, then returned to the top.
- **Scrollbars are hidden** via injected CSS so their width doesn't shrink the
  layout mid-capture.
- **Images are decoded synchronously** (`img.decode()`) so rasterization later
  reads real pixels, not blanks.

With `skipLazyScroll: true` (delayed / hotkey capture — see below) the
scroll-through is skipped and the page stays exactly as the user left it; every
captured rect is shifted by the current `(scrollX, scrollY)` so coordinates
remain in document space.

## Step 2 — Walk the tree (`core/snapshot.ts`)

The walk runs inside a `requestAnimationFrame` (so the browser has finished
layout) with a 10-second abort timeout. `snapshotElement()` visits every node
and dispatches by kind:

| Node kind | How it's captured |
|-----------|-------------------|
| Regular element | Style diff + rect + recurse into children |
| Text node | Measured bounding rect + line count via `Range` |
| `<svg>` | Cloned with every non-default computed style baked in as attributes → self-contained inline markup |
| `<canvas>` | Rasterized to a PNG asset |
| `<video>` | Current frame (or poster) rasterized |
| `<iframe>` (same-origin) | Full descent into `contentDocument`, coordinates offset by the iframe's content box |
| Shadow DOM host | Children read from `element.shadowRoot` instead of light DOM |
| `::before` / `::after` | Captured as style dicts — or synthesized as real positioned child nodes (see below) |
| `::placeholder` | Captured for inputs and textareas |

Invisible nodes are filtered early (`display:none`, `visibility:hidden`,
zero-size boxes with no children, offscreen elements), and `<head>`, `<script>`,
`<style>`, `<noscript>` are skipped entirely.

### Style diffing (`core/styles.ts`)

A computed style has ~350 properties; serializing all of them for every element
would produce enormous payloads. `diffStyles()` compares each element against
`BASELINE_STYLES` — a table of Chrome's default computed values — and keeps only
what deviates. Two exceptions where defaults are force-included:

- **Flex/grid containers and their children** always carry their layout
  properties, because Figma needs them to rebuild Auto Layout even when they
  happen to match browser defaults.
- **Zero-width borders/outlines** are stripped of style/color noise.

### Geometry and transforms (`transform/matrix.ts`)

CSS transforms are parsed into `DOMMatrix` objects and multiplied down the tree
(parent × child), so nested rotations and scales resolve correctly. Each rect
carries axis-aligned bounds plus, for rotated elements, a four-point `quad`.

### Auto Layout inference (`core/layout.ts`)

For each element the engine infers Figma's `FILL` / `HUG` / `FIXED` sizing from
CSS behavior: `flex-grow > 0` → FILL on the main axis, `align-items: stretch` →
FILL on the cross axis, explicit pixel sizes → FIXED, content-driven → HUG, plus
a heuristic for centered `max-width` wrappers.

## Step 3 — Resolve assets and fonts

- **Images/videos/backgrounds** (`media/resolver.ts`): every URL registered
  during the walk is fetched with bounded concurrency (6 at a time), trying in
  order: rasterize the already-decoded `<img>` → direct `fetch` → the
  extension's CORS bridge (background worker fetches cross-origin images with no
  CORS restriction) → rasterize any loaded copy on the page → URL-only fallback.
  AVIF/HEIF are re-encoded to PNG.
- **Fonts** (`typography/probe.ts`): font stacks are parsed and an off-screen
  canvas compares glyph widths against generic fallbacks to determine which
  family actually rendered; weight/style/size usage is recorded per family.

The result — element tree + asset map + font map + viewport metadata — is
serialized to JSON, base64-wrapped in the `(figh2d)` clipboard marker, and
Figma's paste handler reconstructs it as layers.

---

## What our version captures that the stock capture misses

### 1. Same-origin iframe contents (with realm-correct type checks)

Stock capture treats iframes as empty boxes. `snapshotIframe()` descends into
`iframe.contentDocument` and captures the embedded page fully, offsetting every
child coordinate by the iframe's on-page content-box position.

The subtle part is **realm safety**: elements inside an iframe belong to that
iframe's `window`, so `element instanceof SVGElement` (the top window's
constructor) is *always false* for them. The engine resolves constructors from
each element's own realm (`element.ownerDocument.defaultView`), which is why
SVGs, canvases, and images inside iframes are now captured instead of silently
dropped. Cross-origin iframes remain inaccessible by browser design and fall
back to an empty box.

### 2. Absolutely-positioned pseudo-elements as real nodes (toggle-switch knobs)

A `::before`/`::after` captured only as a style dictionary can't be laid out by
Figma — it has no box. `synthesizePseudoNode()` detects the common decorative
case (an absolutely-positioned pseudo on a positioned element, e.g. the knob of
a CSS toggle switch) and emits it as a **real child node** with a computed rect:
offsets resolved against the parent's border box, and the pseudo's own
`transform` translation applied — so a switch captured in the "on" state shows
its knob on the correct side. Pseudos that don't fit this shape still fall back
to the style-dict path.

### 3. Open dropdowns, menus, and hover states

Two capture modes exist specifically because ephemeral UI dies the moment you
interact with the page:

- **Delayed capture ("Capture in 3s")** — a countdown lets the user open the
  menu, then captures with `skipLazyScroll: true` so the lazy-load
  scroll-through doesn't fire scroll events that dismiss it.
- **Instant hotkey (`Ctrl/Cmd+Shift+S`)** — a keypress dismisses nothing (no
  click, no focus change, no timer), so it reliably snapshots whatever is open
  at that exact moment, also with `skipLazyScroll`.

In both modes the page is captured at its current scroll position, with all
rects shifted by the scroll offset so they land correctly in document space.

### 4. Shadow DOM components

Web components are captured through `element.shadowRoot ?? element`, so custom
elements built on Shadow DOM (design-system components, `<video>` controls
skins, etc.) contribute their real rendered children instead of appearing
empty.

### 5. Cross-origin images via the CORS bridge

The capture script runs in the page's MAIN world, where cross-origin image
pixels are unreadable. The extension relays fetch requests through the
background service worker (which is not subject to page CORS), so logos and CDN
images that would otherwise arrive as gray boxes come through as real assets.

### 6. Body-background propagation

When `<html>` has no background, browsers paint the `<body>` background across
the whole viewport. The engine replicates this rule so the root Figma frame
gets the page's actual background color instead of white.
