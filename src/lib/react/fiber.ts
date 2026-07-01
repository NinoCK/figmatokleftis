/**
 * React Fiber introspection utilities.
 *
 * Provides helpers for reading React internal fiber data from DOM elements
 * and extracting Figma source annotations (data-fg-* attributes).
 */

import type { ReactFiber, SourceAnnotation } from '../types.js';

/** Prefix used for Figma source annotation attributes. */
export const DATA_FG_PREFIX = "data-fg-";

/**
 * Check whether an attribute name is a Figma annotation attribute.
 */
function isFigmaAttribute(name: string): boolean {
  return name.startsWith(DATA_FG_PREFIX);
}

/**
 * Retrieve the React Fiber node attached to a DOM element.
 *
 * React attaches an internal fiber via a property whose name begins with
 * `__reactFiber`. This function finds and returns that fiber, if present.
 */
export function getReactFiber(element: Element): ReactFiber | undefined {
  if (!element) return undefined;

  for (const key in element) {
    if (key.startsWith("__reactFiber")) {
      return (element as unknown as Record<string, ReactFiber>)[key];
    }
  }
  return undefined;
}

/**
 * Extract the props object from a React fiber node.
 *
 * Prefers `pendingProps` over `memoizedProps`. The returned object is a
 * shallow copy with the `children` key removed.
 */
export function getFiberProps(fiber: ReactFiber): Record<string, unknown> | undefined {
  if (!fiber) return undefined;

  const props = fiber.pendingProps ?? fiber.memoizedProps;
  if (!props) return undefined;

  const propsCopy = { ...props };
  delete propsCopy.children;
  return propsCopy;
}

/**
 * Parse a single Figma source annotation value string.
 *
 * The value is a colon-delimited string encoding source location metadata
 * (file, line, column, etc.) and the annotation type (element / text / expression).
 */
export function parseSourceAnnotation(sourceId: string, value: string): SourceAnnotation | undefined {
  if (typeof value !== "string" || !sourceId) return undefined;

  const parts = value.split(":");
  const fileGuid = parts[0].replace(/\./g, ":");
  const fileVersion = parts[1] ? "[" + parts[1].replace(/\./g, ":") + "]" : "";
  const filePath = parts[2];
  const line = Number(parts[3]);
  const column = Number(parts[4]);
  const pos = Number(parts[5]);
  const len = Number(parts[6]);
  const annotationType = parts[7];

  switch (annotationType) {
    case "e":
      return {
        type: "element",
        sourceId,
        fileGuid,
        filePath,
        fileVersion,
        line,
        column,
        pos,
        len,
        name: parts[8],
        childTypes: parts[9]
          ? parts[9] === "_"
            ? []
            : parts[9].split("")
          : undefined,
        isComponentDefinition: parts[10] === "1" ? true : undefined,
        assetKey: parts[11] ? parts[11] : undefined,
        makeLibraryId: parts[12] ? parts[12] : undefined,
        libraryId: parts[13] ? parts[13] : undefined,
        componentId: parts[14] ? parts[14] : undefined,
        isLibraryInstance: parts[15] === "1" ? true : undefined,
      };

    case "t":
      return {
        type: "text",
        sourceId,
        fileGuid,
        filePath,
        fileVersion,
        line,
        column,
        pos,
        len,
      };

    case "x":
      return {
        type: "expression",
        sourceId,
        fileGuid,
        filePath,
        fileVersion,
        line,
        column,
        pos,
        len,
      };

    default:
      return undefined;
  }
}

/**
 * Collect all Figma source annotations from a React fiber props object.
 *
 * Iterates over the props looking for keys that start with `data-fg-` and
 * parses each matching string value into an annotation object.
 */
export function collectSourceAnnotations(props: Record<string, unknown>): SourceAnnotation[] {
  const annotations: SourceAnnotation[] = [];
  if (!props) return annotations;

  for (const [attrName, attrValue] of Object.entries(props)) {
    if (!isFigmaAttribute(attrName) || typeof attrValue !== "string") continue;

    const segments = attrName.split("-");
    if (segments.length === 3) {
      const sourceId = segments[2];
      const annotation = parseSourceAnnotation(sourceId, attrValue);
      if (annotation) {
        annotations.push(annotation);
      }
    }
  }

  return annotations;
}

/**
 * Get Figma source annotations for a DOM element.
 *
 * First attempts to read annotations via the React fiber (if the element was
 * rendered by React). Falls back to reading `data-fg-*` DOM attributes directly.
 */
export function getSourceAnnotations(element: Element): SourceAnnotation[] | undefined {
  // Try the React fiber path first.
  const fiber = getReactFiber(element);
  if (fiber) {
    const props = getFiberProps(fiber);
    if (props) {
      const annotations = collectSourceAnnotations(props);
      if (annotations.length > 0) return annotations;
    }
  }

  // Fall back to reading DOM attributes directly.
  if (element?.attributes) {
    const annotations: SourceAnnotation[] = [];
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      if (attr?.name.startsWith(DATA_FG_PREFIX)) {
        const sourceId = attr.name.split("-")[2];
        const annotation = parseSourceAnnotation(sourceId, attr.value);
        if (annotation) {
          annotations.push(annotation);
        }
      }
    }
    if (annotations.length > 0) return annotations;
  }

  return undefined;
}

/**
 * Read the `data-fginspector-selected` attribute from a DOM element.
 */
export function getInspectorSelectedId(element: Element): string | undefined {
  return element?.getAttribute("data-fginspector-selected") ?? undefined;
}
