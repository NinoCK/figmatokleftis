/**
 * DOM snapshot engine — orchestrates the capture pipeline.
 */

import { getSourceAnnotations, getInspectorSelectedId } from '../react/fiber.js';
import { TypefaceProbe, resolveFonts } from '../typography/probe.js';
import { ResourceResolver, CaptureError, resolveResources, canvasToBlob } from '../media/resolver.js';
import { bakeSvgStyles } from '../media/svg.js';
import { resolveTransform, multiplyMatrices, getElementRect } from '../transform/matrix.js';
import { extractComponentTree, findParentComponent } from '../react/tree.js';
import { inferLayoutSizing } from './layout.js';
import { NODE_TYPES, isNodeVisible, shouldPruneNode, iterateChildNodes, getTextRect, getElementAttributes, matrixToSimple, INPUT_TYPES_WITH_PLACEHOLDER } from './walker.js';
import { diffStyles, ensureFlexProps, ensureGridProps, ensureFlexItemProps, BASELINE_STYLES } from './styles.js';
import { prepareForCapture, decodeImages, assertLayoutValid, resetScrollbarState, cleanupScrollbar } from './prepare.js';
import { getDeclaredLayoutStyles } from './declared.js';
import type {
  CaptureTree,
  SnapshotNode,
  ElementSnapshot,
  TextSnapshot,
  CaptureOptions,
  CaptureContext,
  SimpleMatrix,
  SourceAnnotation,
  Point,
  ElementRect,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CAPTURE_TIMEOUT = 10000;

/** Zero coordinate offset — used for the top document (no iframe shift). */
const ZERO_OFFSET: Point = { x: 0, y: 0 };

/**
 * Shift a rect (and its rotated quad, if any) by an accumulated offset.
 *
 * Elements inside an iframe are measured in the iframe's own viewport
 * coordinates; adding the iframe's position in the top document places them
 * correctly alongside the rest of the capture.
 */
function offsetRect(rect: ElementRect, offset: Point): ElementRect {
  if (offset.x === 0 && offset.y === 0) return rect;
  const shifted: ElementRect = { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
  if (rect.quad) {
    shifted.quad = {
      p1: { x: rect.quad.p1.x + offset.x, y: rect.quad.p1.y + offset.y },
      p2: { x: rect.quad.p2.x + offset.x, y: rect.quad.p2.y + offset.y },
      p3: { x: rect.quad.p3.x + offset.x, y: rect.quad.p3.y + offset.y },
      p4: { x: rect.quad.p4.x + offset.x, y: rect.quad.p4.y + offset.y },
    };
  }
  return shifted;
}

export const DEFAULT_CONFIG: Required<Omit<CaptureOptions, 'timeoutSignal'>> = {
  assertLayoutValid: true,
  skipRemoteAssetSerialization: false,
  includeReactFiberTree: false,
  captureDeclaredStyles: false,
};

// ---------------------------------------------------------------------------
// Node ID tracking
// ---------------------------------------------------------------------------

let nodeIdCounter = 0;
const nodeIdMap = new WeakMap<Node, string>();

/**
 * Generate or retrieve a unique h2d node ID for a DOM node.
 */
function generateNodeId(node: Node | null): string {
  if (node !== null) {
    const existing = nodeIdMap.get(node);
    if (existing) return existing;
  }
  const id = `h2d-node-${++nodeIdCounter}`;
  if (node !== null) nodeIdMap.set(node, id);
  return id;
}

/**
 * Retrieve the h2d node ID for an element without generating a new one.
 */
export function getNodeId(element: Node): string | undefined {
  return nodeIdMap.get(element);
}

// ---------------------------------------------------------------------------
// requestAnimationFrame helper
// ---------------------------------------------------------------------------

/**
 * Schedule a callback in a requestAnimationFrame, honouring an AbortSignal.
 */
function safeRequestAnimationFrame(callback: (timestamp: number) => void, signal: AbortSignal): void {
  if (signal.aborted) return;

  const frameId = requestAnimationFrame((timestamp) => {
    if (!signal.aborted) callback(timestamp);
  });

  signal.addEventListener("abort", () => cancelAnimationFrame(frameId), {
    once: true,
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Serialize a DOM element or document into a capture tree.
 */
export async function captureDOM(elementOrDocument: Element | Document, options?: CaptureOptions): Promise<CaptureTree> {
  const mergedOptions = { ...DEFAULT_CONFIG, ...options };
  const ctx: CaptureContext = {
    captureDeclaredStyles: mergedOptions.captureDeclaredStyles === true,
    declaredStylesCache: mergedOptions.captureDeclaredStyles ? new Map() : undefined,
  };

  assertLayoutValid(mergedOptions);
  nodeIdCounter = 0;
  resetScrollbarState();

  const assetCollector = new ResourceResolver(mergedOptions);
  const fontCollector = new TypefaceProbe();

  try {
    return await captureDOMInner(elementOrDocument, mergedOptions, ctx, assetCollector, fontCollector);
  } finally {
    cleanupScrollbar();
  }
}

async function captureDOMInner(
  elementOrDocument: Element | Document,
  mergedOptions: Required<Omit<CaptureOptions, 'timeoutSignal'>> & CaptureOptions,
  ctx: CaptureContext,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
): Promise<CaptureTree> {

  if (elementOrDocument instanceof Element) {
    // Scroll through the page to trigger lazy-loaded images
    await prepareForCapture(elementOrDocument);
    await decodeImages(Array.from(elementOrDocument.querySelectorAll("img")));

    const serialized = await snapshotInAnimationFrame(
      elementOrDocument,
      assetCollector,
      fontCollector,
      mergedOptions,
      ctx,
    );

    const blobMap = await assetCollector.getBlobMap();
    const fonts = fontCollector.getFonts();
    const { width, height } = elementOrDocument.getBoundingClientRect();

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node could not be serialized");
    }

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(elementOrDocument, getNodeId) }
      : undefined;

    return {
      root: serialized as ElementSnapshot,
      documentTitle: document.title || undefined,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: elementOrDocument.scrollWidth,
        height: elementOrDocument.scrollHeight,
      },
      viewportRect: {
        x: elementOrDocument.scrollLeft,
        y: elementOrDocument.scrollTop,
        width,
        height,
      },
      devicePixelRatio: window.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  } else if (elementOrDocument instanceof Document) {
    await prepareForCapture(elementOrDocument.documentElement);
    await decodeImages(Array.from(elementOrDocument.images));

    const serialized = await snapshotInAnimationFrame(
      elementOrDocument.documentElement,
      assetCollector,
      fontCollector,
      mergedOptions,
      ctx,
    );

    const blobMap = await assetCollector.getBlobMap();
    const fonts = fontCollector.getFonts();

    if (!serialized || serialized.nodeType !== NODE_TYPES.ELEMENT_NODE) {
      throw new Error("Container node must have a body element");
    }

    const experimental = mergedOptions.includeReactFiberTree
      ? { reactFiberTree: extractComponentTree(elementOrDocument.documentElement, getNodeId) }
      : undefined;

    return {
      documentTitle: elementOrDocument.title || undefined,
      root: serialized as ElementSnapshot,
      experimental,
      documentRect: {
        x: 0,
        y: 0,
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      viewportRect: {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      },
      devicePixelRatio: window.devicePixelRatio,
      assets: blobMap,
      fonts,
    };
  }

  throw new Error("Container node must be an Element or Document");
}

// ---------------------------------------------------------------------------
// Animation-frame serialization
// ---------------------------------------------------------------------------

/**
 * Schedule the DOM tree walk inside a requestAnimationFrame and apply a
 * timeout via an AbortSignal.
 */
function snapshotInAnimationFrame(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  options: CaptureOptions,
  ctx: CaptureContext,
): Promise<SnapshotNode | null> {
  assertLayoutValid(options);

  const signal = options.timeoutSignal ?? AbortSignal.timeout(CAPTURE_TIMEOUT);

  return new Promise((resolve, reject) => {
    safeRequestAnimationFrame(
      () => resolve(snapshotNode(element, assetCollector, fontCollector, undefined, ctx)),
      signal,
    );

    signal.addEventListener(
      "abort",
      () => reject(new CaptureError("requestAnimationFrame timed out", "PAGE_NOT_RESPONDING")),
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Node dispatcher
// ---------------------------------------------------------------------------

/**
 * Serialize a single DOM node, dispatching to element or text serializers.
 */
function snapshotNode(
  node: Node | Node[],
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  parentTransform: DOMMatrix | undefined,
  ctx: CaptureContext,
  offset: Point = ZERO_OFFSET,
): SnapshotNode | null {
  if (Array.isArray(node) || node.nodeType === Node.TEXT_NODE) {
    return snapshotTextNode(node, offset);
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    return snapshotElement(node as Element, assetCollector, fontCollector, parentTransform, ctx, offset);
  }

  if (node.nodeType !== Node.COMMENT_NODE) {
    console.warn(`Unsupported node type: ${node.nodeType}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Element serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a single DOM element into the capture node format.
 */
function snapshotElement(
  element: Element,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  parentTransform: DOMMatrix | undefined,
  ctx: CaptureContext,
  offset: Point = ZERO_OFFSET,
): ElementSnapshot | null {
  const childNodes: SnapshotNode[] = [];
  let svgContent: string | undefined;
  let placeholderUrl: string | undefined;
  let selectionSourceId: string | undefined;

  if (!isNodeVisible(element)) return null;

  const tag = element.tagName.toUpperCase();

  // Skip non-visual elements entirely.
  if (tag === "HEAD" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return null;
  }

  // Resolve DOM constructors from the element's own realm. Elements inside a
  // same-origin iframe belong to that iframe's window, so `instanceof` against
  // the top window's constructors is always false (that's why iframe SVGs/
  // canvases/images were being missed).
  const view = element.ownerDocument?.defaultView ?? window;

  // Source annotations from React/Figma instrumentation.
  const sources = getSourceAnnotations(element);
  if (sources && sources.length > 0) {
    // If there is exactly one text child with a source annotation, wrap it.
    if (sources[0]?.type === "text" && element.childNodes.length === 1) {
      const textNode = snapshotTextNode(element.childNodes[0]);
      (textNode as TextSnapshot & { sources?: SourceAnnotation[] }).sources = sources;
      return textNode as unknown as ElementSnapshot;
    }
    selectionSourceId = getInspectorSelectedId(element);
  }

  // Computed style diff vs defaults.
  const computedStyles = diffStyles(element);

  // Browser propagates body background to the viewport when html has no background.
  // Replicate this so Figma shows the correct background on the root frame.
  if (tag === "HTML" && !computedStyles.backgroundColor && !computedStyles.backgroundImage) {
    const ownerBody = element.ownerDocument?.body;
    const bodyBg = ownerBody ? window.getComputedStyle(ownerBody).backgroundColor : "";
    if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)") {
      computedStyles.backgroundColor = bodyBg;
    }
  }

  // For flex/grid containers, always include layout properties even if they
  // match browser defaults — Figma needs them to reconstruct the layout.
  const displayValue = computedStyles.display;
  if (displayValue === "flex" || displayValue === "inline-flex") {
    ensureFlexProps(element, computedStyles);
  } else if (displayValue === "grid" || displayValue === "inline-grid") {
    ensureGridProps(element, computedStyles);
  }

  // For flex/grid children, always include item-level properties.
  const parentDisplay = element.parentElement
    ? window.getComputedStyle(element.parentElement).display
    : "";
  if (
    parentDisplay === "flex" || parentDisplay === "inline-flex" ||
    parentDisplay === "grid" || parentDisplay === "inline-grid"
  ) {
    ensureFlexItemProps(element, computedStyles);
  }

  // Declared grid styles (if enabled).
  const declaredStyles =
    ctx?.captureDeclaredStyles === true && ctx.declaredStylesCache
      ? getDeclaredLayoutStyles(element, ctx.declaredStylesCache)
      : {};

  // Transform matrix.
  const elementTransform = resolveTransform(computedStyles as unknown as CSSStyleDeclaration);
  const combinedTransform = multiplyMatrices(parentTransform, elementTransform);

  // SVG: serialize inline; Canvas: rasterize; iframe: descend into the
  // same-origin document; otherwise: recurse children.
  if (element instanceof view.SVGElement) {
    svgContent = bakeSvgStyles(element);
  } else if (element instanceof view.HTMLCanvasElement) {
    placeholderUrl = assetCollector.addCanvas(element);
  } else if (element instanceof view.HTMLIFrameElement) {
    const frameChild = snapshotIframe(element, assetCollector, fontCollector, ctx, offset);
    if (frameChild != null) childNodes.push(frameChild);
  } else {
    const root = element.shadowRoot ?? element;
    for (const childOrGroup of iterateChildNodes(root)) {
      const serialized = snapshotNode(childOrGroup, assetCollector, fontCollector, combinedTransform, ctx, offset);
      if (serialized != null) childNodes.push(serialized);
    }
  }

  // Pseudo-element styles (::before, ::after, ::placeholder).
  let pseudoElementStyles: Record<string, Record<string, string>> | undefined;

  // ::before / ::after — capture when they have visible content
  for (const pseudo of ["::before", "::after"] as const) {
    const pseudoComputed = window.getComputedStyle(element, pseudo);
    const contentValue = pseudoComputed.content;
    if (contentValue && contentValue !== "none" && contentValue !== "normal") {
      if (!pseudoElementStyles) pseudoElementStyles = {};
      const styles = diffStyles(element, pseudo);
      styles.content = contentValue;
      pseudoElementStyles[pseudo === "::before" ? "before" : "after"] = styles;
    }
  }

  // ::placeholder for inputs/textareas
  if (
    (element instanceof view.HTMLInputElement && INPUT_TYPES_WITH_PLACEHOLDER.has(element.type)) ||
    element instanceof view.HTMLTextAreaElement
  ) {
    if (element.placeholder) {
      if (!pseudoElementStyles) pseudoElementStyles = {};
      pseudoElementStyles.placeholder = diffStyles(element, "::placeholder");
    }
  }

  // Collect images/videos/backgrounds and font usage.
  resolveResources(element, computedStyles as unknown as CSSStyleDeclaration, assetCollector);
  resolveFonts(element, computedStyles as unknown as CSSStyleDeclaration, fontCollector);

  // Element bounding rect (may include rotated quad), shifted into top-document
  // coordinates when we are inside an iframe (offset is zero otherwise).
  const rect = offsetRect(
    getElementRect(element, computedStyles as unknown as CSSStyleDeclaration, combinedTransform),
    offset,
  );

  // Prune invisible nodes (zero-size without children, offscreen, etc.)
  if (shouldPruneNode(element, rect, childNodes)) {
    return null;
  }

  // Infer layout sizing hints for Figma Auto Layout.
  const sizing = inferLayoutSizing(element, computedStyles, element.parentElement);

  const node: ElementSnapshot = {
    nodeType: Node.ELEMENT_NODE as 1,
    id: generateNodeId(element),
    tag,
    attributes: getElementAttributes(element),
    styles: computedStyles,
    rect,
    childNodes,
    content: svgContent,
    placeholderUrl,
    pseudoElementStyles,
    owningReactComponent: findParentComponent(element),
    sources,
    selectionSourceId,
    relativeTransform: elementTransform ? matrixToSimple(elementTransform) : undefined,
    layoutSizingHorizontal: sizing.horizontal,
    layoutSizingVertical: sizing.vertical,
  };

  if (Object.keys(declaredStyles).length > 0) {
    node.declaredStyles = declaredStyles;
  }

  return node;
}

// ---------------------------------------------------------------------------
// Text node serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a text node (or group of adjacent text nodes).
 */
function snapshotTextNode(nodeOrNodes: Node | Node[], offset: Point = ZERO_OFFSET): TextSnapshot {
  const { lineCount, ...rect } = getTextRect(nodeOrNodes);

  const text = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.map((n) => n.textContent || "").join("")
    : nodeOrNodes.textContent || "";

  const identityNode = Array.isArray(nodeOrNodes)
    ? nodeOrNodes.length === 1
      ? nodeOrNodes[0]
      : null
    : nodeOrNodes;

  return {
    nodeType: Node.TEXT_NODE as 3,
    id: generateNodeId(identityNode),
    text,
    rect:
      offset.x === 0 && offset.y === 0
        ? rect
        : { ...rect, x: rect.x + offset.x, y: rect.y + offset.y },
    lineCount,
  };
}

/**
 * Descend into a same-origin `<iframe>` and serialize its document as a child
 * node, shifting all coordinates by the iframe's on-page position.
 *
 * Cross-origin iframes are inaccessible (the browser blocks `contentDocument`);
 * for those we return null and the iframe is captured as an empty box.
 *
 * ponytail: does not pre-scroll the iframe for lazy images, and does not
 * compose a CSS-transformed iframe's matrix — add if a real page needs it.
 */
function snapshotIframe(
  iframe: HTMLIFrameElement,
  assetCollector: ResourceResolver,
  fontCollector: TypefaceProbe,
  ctx: CaptureContext,
  offset: Point,
): SnapshotNode | null {
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    return null; // cross-origin — access denied
  }
  if (!doc || !doc.documentElement) return null;

  // The iframe's content origin is its content box (inside border + padding).
  const rect = iframe.getBoundingClientRect();
  const cs = window.getComputedStyle(iframe);
  const childOffset: Point = {
    x: offset.x + rect.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
    y: offset.y + rect.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0),
  };

  // Fresh transform context: the content root is positioned purely by offset.
  return snapshotElement(doc.documentElement, assetCollector, fontCollector, undefined, ctx, childOffset);
}
