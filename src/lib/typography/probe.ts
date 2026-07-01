/**
 * Font collection utilities.
 *
 * Provides helpers for detecting available fonts, collecting font usage data
 * from the DOM, and parsing CSS font-related values.
 */

import type { FontData, FontUsage } from '../types.js';

/**
 * Convert a CSS `font-stretch` percentage value to its keyword equivalent.
 */
export function fontStretchToKeyword(percentValue: string): string {
  if (!percentValue.endsWith("%")) return percentValue.toLowerCase();

  const numeric = parseFloat(percentValue);
  if (isNaN(numeric)) return "normal";

  if (numeric <= 50) return "ultra-condensed";
  if (numeric <= 62.5) return "extra-condensed";
  if (numeric <= 75) return "condensed";
  if (numeric <= 87.5) return "semi-condensed";
  if (numeric <= 100) return "normal";
  if (numeric <= 112.5) return "semi-expanded";
  if (numeric <= 125) return "expanded";
  if (numeric <= 150) return "extra-expanded";
  return "ultra-expanded";
}

/**
 * Parse a CSS `font-family` string into an array of individual family names.
 *
 * Handles quoted names (single or double quotes) and unquoted names separated
 * by commas.
 */
export function parseFontFamily(fontFamilyString: string): string[] {
  const families: string[] = [];
  const pattern = /(?:"([^"]+)"|'([^']+)'|([^,\s][^,]*))/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fontFamilyString)) !== null) {
    const familyName = (match[1] ?? match[2] ?? match[3])?.trim();
    if (familyName) {
      families.push(familyName);
    }
  }

  return families;
}

/**
 * Collects and tracks font usage across a captured document.
 *
 * Uses an off-screen canvas to detect whether a given font family is actually
 * available in the browser by comparing glyph measurements against generic
 * fallback families.
 */
export class TypefaceProbe {
  families = new Map<string, FontData>();
  processedUsages = new Set<string>();
  unavailable = new Set<string>();

  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;

  /**
   * Lazily create and return a 2D canvas rendering context for text measurement.
   */
  get ctx(): CanvasRenderingContext2D | null {
    if (!this._ctx) {
      this._canvas = document.createElement("canvas");
      this._ctx = this._canvas.getContext("2d");
    }
    return this._ctx;
  }

  /**
   * Check whether a specific font variant is available in the current browser
   * by comparing rendered text width against generic fallback families.
   */
  checkFontAvailable(familyName: string, fontStretch: string, fontStyle: string, fontWeight: string): boolean {
    if (!this.ctx) return false;

    const testString = "mmmmmmmmmmlli";
    const testSize = "72px";
    const stretchKeyword = fontStretchToKeyword(fontStretch);
    const fallbackFamilies = ["monospace", "sans-serif", "serif"];

    for (const fallback of fallbackFamilies) {
      this.ctx.font = `${stretchKeyword} ${fontStyle} ${fontWeight} ${testSize} ${fallback}`;
      const fallbackWidth = this.ctx.measureText(testString).width;

      this.ctx.font = `${stretchKeyword} ${fontStyle} ${fontWeight} ${testSize} "${familyName}", ${fallback}`;
      const candidateWidth = this.ctx.measureText(testString).width;

      if (fallbackWidth !== candidateWidth) return true;
    }

    return false;
  }

  /**
   * Register a font family and record its usage if the font is available.
   *
   * Parses the CSS `font-family` string, resolves the first available family,
   * and stores it along with the usage details.
   */
  addFontFamily(fontFamilyStr: string, fontStretch: string, fontStyle: string, fontWeight: string, fontSize: string): void {
    const families = parseFontFamily(fontFamilyStr);

    for (const family of families) {
      const normalizedName = family.toLowerCase();
      const unavailableKey = `${normalizedName}|${fontStretch}|${fontStyle}|${fontWeight}`;

      if (this.unavailable.has(unavailableKey)) continue;

      // If this family was already registered, just add the usage.
      if (this.families.has(normalizedName)) {
        this.addUsage(normalizedName, fontStretch, fontStyle, fontWeight, fontSize);
        return;
      }

      // Check whether this font variant is actually available.
      if (!this.checkFontAvailable(family, fontStretch, fontStyle, fontWeight)) {
        this.unavailable.add(unavailableKey);
        continue;
      }

      // Register the new family and record the usage.
      this.families.set(normalizedName, {
        familyName: family,
        faces: [],
        usages: [],
      });
      this.addUsage(normalizedName, fontStretch, fontStyle, fontWeight, fontSize);
      return;
    }
  }

  /**
   * Record a specific font usage, deduplicating by a composite key.
   */
  addUsage(normalizedFamily: string, fontStretch: string, fontStyle: string, fontWeight: string, fontSize: string): void {
    const usageKey = `${normalizedFamily}|${fontStretch}|${fontStyle}|${fontWeight}|${fontSize}`;
    if (this.processedUsages.has(usageKey)) return;

    this.processedUsages.add(usageKey);

    const familyEntry = this.families.get(normalizedFamily);
    if (familyEntry) {
      familyEntry.usages.push({
        fontWeight,
        fontStyle,
        fontStretch,
        fontSize,
      } satisfies FontUsage);
    }
  }

  /**
   * Retrieve all collected fonts as a plain object.
   *
   * Calls `collectWebFontFaces()` before returning so that subclasses can
   * populate the `faces` arrays with @font-face data.
   */
  getFonts(): Record<string, FontData> {
    this.collectWebFontFaces();
    return Object.fromEntries(this.families);
  }

  /**
   * Hook for subclasses to populate web font face data.
   *
   * The base implementation is a no-op; subclasses override this to extract
   * @font-face descriptors from stylesheets.
   */
  collectWebFontFaces(): void {
    // No-op in base class; intended to be overridden.
  }
}

/**
 * Collect font usage information for a single DOM element.
 *
 * Reads font-related computed style properties and registers the usage with
 * the provided `TypefaceProbe`.
 */
export function resolveFonts(element: Element, computedStyle: CSSStyleDeclaration, fontCollector: TypefaceProbe): void {
  const fontWeight = computedStyle.fontWeight ?? "400";
  const fontStyle = computedStyle.fontStyle === "italic" ? "italic" : "normal";
  const fontStretch = computedStyle.fontStretch ?? "100%";
  const fontSize = computedStyle.fontSize ?? "16px";
  const fontFamily = computedStyle.fontFamily ?? "Times";

  fontCollector.addFontFamily(fontFamily, fontStretch, fontStyle, fontWeight, fontSize);
}
