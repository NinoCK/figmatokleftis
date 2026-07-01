/**
 * Declared CSS layout style matching via stylesheet inspection.
 *
 * Scans document stylesheets for flex/grid rules and matches them against
 * elements to retrieve authored (declared) layout property values.
 */

import type { StylesheetCache, GridRuleEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Style key mappings
// ---------------------------------------------------------------------------

/** CSS Flex property mappings (JS camelCase -> CSS kebab-case). */
const FLEX_STYLE_KEYS = [
  { jsKey: "display", cssKey: "display" },
  { jsKey: "flexDirection", cssKey: "flex-direction" },
  { jsKey: "flexWrap", cssKey: "flex-wrap" },
  { jsKey: "justifyContent", cssKey: "justify-content" },
  { jsKey: "alignItems", cssKey: "align-items" },
  { jsKey: "alignContent", cssKey: "align-content" },
  { jsKey: "columnGap", cssKey: "column-gap" },
  { jsKey: "rowGap", cssKey: "row-gap" },
  { jsKey: "gap", cssKey: "gap" },
  { jsKey: "flexGrow", cssKey: "flex-grow" },
  { jsKey: "flexShrink", cssKey: "flex-shrink" },
  { jsKey: "flexBasis", cssKey: "flex-basis" },
  { jsKey: "alignSelf", cssKey: "align-self" },
  { jsKey: "order", cssKey: "order" },
  { jsKey: "flex", cssKey: "flex" },
] as const;

/** CSS Grid property mappings (JS camelCase -> CSS kebab-case). */
const GRID_STYLE_KEYS = [
  { jsKey: "display", cssKey: "display" },
  { jsKey: "gridTemplateColumns", cssKey: "grid-template-columns" },
  { jsKey: "gridTemplateRows", cssKey: "grid-template-rows" },
  { jsKey: "gridColumnStart", cssKey: "grid-column-start" },
  { jsKey: "gridColumnEnd", cssKey: "grid-column-end" },
  { jsKey: "gridRowStart", cssKey: "grid-row-start" },
  { jsKey: "gridRowEnd", cssKey: "grid-row-end" },
  { jsKey: "columnGap", cssKey: "column-gap" },
  { jsKey: "rowGap", cssKey: "row-gap" },
  { jsKey: "gap", cssKey: "gap" },
  { jsKey: "gridAutoFlow", cssKey: "grid-auto-flow" },
  { jsKey: "gridTemplateAreas", cssKey: "grid-template-areas" },
  { jsKey: "gridAutoColumns", cssKey: "grid-auto-columns" },
  { jsKey: "gridAutoRows", cssKey: "grid-auto-rows" },
  { jsKey: "gridColumn", cssKey: "grid-column" },
  { jsKey: "gridRow", cssKey: "grid-row" },
] as const;

const CSS_MEDIA_RULE = 4;
const CSS_SUPPORTS_RULE = 12;

// ---------------------------------------------------------------------------
// Layout key aggregation
// ---------------------------------------------------------------------------

type StyleKeyMapping = readonly { readonly jsKey: string; readonly cssKey: string }[];

/** All layout-related style keys (grid + flex) for stylesheet scanning. */
const LAYOUT_STYLE_KEYS: StyleKeyMapping = [...FLEX_STYLE_KEYS, ...GRID_STYLE_KEYS];

// ---------------------------------------------------------------------------
// Rule collection & matching
// ---------------------------------------------------------------------------

/**
 * Check whether a CSSStyleDeclaration has any layout-related properties set.
 */
function hasLayoutStyles(style: CSSStyleDeclaration): boolean {
  for (const { cssKey } of LAYOUT_STYLE_KEYS) {
    if (style.getPropertyValue(cssKey).trim()) return true;
  }
  return false;
}

/**
 * Recursively collect CSS rules that contain layout (grid or flex) styles.
 */
function collectLayoutRules(ruleList: CSSRuleList): GridRuleEntry[] {
  const entries: GridRuleEntry[] = [];

  for (let i = 0; i < ruleList.length; i++) {
    const rule = ruleList[i];
    if (rule == null) continue;

    if (rule.type === CSSRule.STYLE_RULE) {
      const styleRule = rule as CSSStyleRule;
      if (hasLayoutStyles(styleRule.style)) {
        entries.push({ type: "style", rule: styleRule });
      }
      continue;
    }

    if (rule.type === CSS_MEDIA_RULE) {
      const mediaRule = rule as CSSMediaRule;
      const innerEntries = collectLayoutRules(mediaRule.cssRules);
      if (innerEntries.length > 0) {
        entries.push({
          type: "media",
          mediaText: mediaRule.media.mediaText,
          inner: innerEntries,
        });
      }
      continue;
    }

    if (rule.type === CSS_SUPPORTS_RULE) {
      const supportsRule = rule as CSSSupportsRule;
      try {
        const cssApi = globalThis.CSS;
        if (cssApi?.supports(supportsRule.conditionText)) {
          entries.push(...collectLayoutRules(supportsRule.cssRules));
        }
      } catch (_ignored) {
        // Silently skip invalid @supports conditions.
      }
      continue;
    }

    // Generic grouping rule fallback.
    if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
      entries.push(...collectLayoutRules((rule as CSSGroupingRule).cssRules));
    }
  }

  return entries;
}

/**
 * Build a cache of layout-related CSS rules from all stylesheets in the document.
 */
export function buildStylesheetCache(doc: Document): StylesheetCache {
  const entries: GridRuleEntry[] = [];

  for (let i = 0; i < doc.styleSheets.length; i++) {
    const sheet = doc.styleSheets[i];
    if (sheet == null) continue;

    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules ?? sheet.rules;
    } catch (_ignored) {
      continue;
    }

    if (rules) entries.push(...collectLayoutRules(rules));
  }

  return { entries, matchMediaCache: new Map() };
}

/**
 * Match layout-related rules against an element and return their declared values.
 */
function matchLayoutRules(element: Element, cache: StylesheetCache, defaultView: Window | null): Record<string, string> {
  const result: Record<string, string> = {};
  const { entries, matchMediaCache } = cache;

  function processEntries(items: GridRuleEntry[]): void {
    for (const entry of items) {
      if (entry.type === "media") {
        let matches = matchMediaCache.get(entry.mediaText);
        if (matches === undefined) {
          matches = defaultView ? defaultView.matchMedia(entry.mediaText).matches : false;
          matchMediaCache.set(entry.mediaText, matches);
        }
        if (matches) processEntries(entry.inner);
        continue;
      }

      try {
        if (!element.matches(entry.rule.selectorText)) continue;
      } catch (_ignored) {
        continue;
      }

      const style = entry.rule.style;
      for (const { jsKey, cssKey } of LAYOUT_STYLE_KEYS) {
        const value = style.getPropertyValue(cssKey);
        if (value) result[jsKey] = value.trim();
      }
    }
  }

  processEntries(entries);
  return result;
}

/**
 * Get declared layout styles (grid + flex) for an element, using a per-document stylesheet cache.
 */
export function getDeclaredLayoutStyles(element: Element, cacheMap: Map<Document, StylesheetCache>): Record<string, string> {
  const ownerDoc = element.ownerDocument;
  if (typeof ownerDoc === "undefined" || !ownerDoc.styleSheets) return {};

  let cache = cacheMap.get(ownerDoc);
  if (!cache) {
    cache = buildStylesheetCache(ownerDoc);
    cacheMap.set(ownerDoc, cache);
  }

  return matchLayoutRules(element, cache, ownerDoc.defaultView ?? null);
}
