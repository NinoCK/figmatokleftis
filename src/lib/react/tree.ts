/**
 * React Fiber tree serialization.
 *
 * Builds a serializable representation of the React component tree
 * starting from a DOM element, including component names, fiber tags,
 * and serialized props with truncation / reference handling.
 */

import { getReactFiber, getFiberProps } from "./fiber.js";
import type { ReactFiber, SerializedFiberNode, TruncatedPropValue, PropRefValue } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum string length for a serialized prop value before truncation. */
const MAX_PROP_LENGTH = 100;

/**
 * Enum-like mapping of React Fiber tag values.
 * Keys are human-readable tag names; values are the numeric tags used
 * internally by React's reconciler.
 */
export const FIBER_TAGS = Object.freeze({
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  HostText: 6,
  Fragment: 7,
  Mode: 8,
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16,
  IncompleteClassComponent: 17,
  DehydratedFragment: 18,
  SuspenseListComponent: 19,
  ScopeComponent: 21,
  OffscreenComponent: 22,
  LegacyHiddenComponent: 23,
  CacheComponent: 24,
  TracingMarkerComponent: 25,
  HostHoistable: 26,
  HostSingleton: 27,
  IncompleteFunctionComponent: 28,
  Throw: 29,
  ViewTransitionComponent: 30,
  ActivityComponent: 31,
} as const);

// ---------------------------------------------------------------------------
// Private state
// ---------------------------------------------------------------------------

/**
 * WeakMap that assigns stable reference identifiers to non-primitive prop
 * values (objects and functions) so they can be referenced across the
 * serialized tree without duplicating data.
 */
const propRefMap = new WeakMap<object, string>();

/** Counter used to generate unique prop reference identifiers. */
let propRefCounter = 0;

/**
 * Set of fiber tags that represent "component" fibers (as opposed to host /
 * DOM fibers). Used by findWrappingComponent to decide which
 * ancestors are meaningful component boundaries.
 *
 * Tags: FunctionComponent (0), ClassComponent (1), ForwardRef (11),
 *       MemoComponent (14), SimpleMemoComponent (15).
 */
const COMPONENT_FIBER_TAGS = new Set<number>([0, 1, 11, 14, 15]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a serialized React component tree starting from a DOM element.
 *
 * Locates the nearest React fiber attached to `element` (or its descendants),
 * then recursively serializes the fiber subtree into a plain-object
 * representation suitable for JSON encoding.
 */
export function extractComponentTree(element: Element, getNodeId: (node: Node) => string | undefined): SerializedFiberNode | null {
  // Reset the ref counter for each tree build so that identifiers are
  // deterministic within a single capture pass.
  propRefCounter = 0;

  const rootFiber = findRootFiber(element);
  return rootFiber ? captureFiberNode(rootFiber, getNodeId) : null;
}

/**
 * Find the name of the React component that "owns" a DOM element.
 *
 * Walks `_debugOwner` links when available (React development builds),
 * skipping components that carry Figma instrumentation props (`_fgT`).
 * Falls back to findWrappingComponent for production builds.
 */
export function findParentComponent(element: Element): string | undefined {
  const fiber = getReactFiber(element);
  if (fiber == null) return undefined;

  // Development builds expose _debugOwner.
  if (fiber._debugOwner) {
    let current: ReactFiber = fiber;

    // Skip past intermediate owners that carry Figma tracking props.
    while (
      current._debugOwner &&
      (current._debugOwner.memoizedProps as Record<string, unknown> | null)?._fgT != null
    ) {
      current = current._debugOwner;
    }

    return current._debugOwner
      ? getFiberDisplayName(current._debugOwner)
      : undefined;
  }

  // Production fallback: walk parent fibers.
  return findWrappingComponent(fiber) ?? undefined;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Recursively search for the first React fiber node attached to `element`
 * or any of its descendants.
 */
function findRootFiber(element: Element): ReactFiber | undefined {
  const fiber = getReactFiber(element);
  if (fiber) return fiber;

  if (element instanceof Element) {
    // First pass: direct children only.
    for (const child of element.children) {
      const childFiber = getReactFiber(child);
      if (childFiber) return childFiber;
    }

    // Second pass: recurse into subtrees.
    for (const child of element.children) {
      const found = findRootFiber(child);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * Recursively serialize a single React fiber node and its children.
 */
function captureFiberNode(fiber: ReactFiber, getNodeId: (node: Node) => string | undefined): SerializedFiberNode {
  const fiberTag = fiber.tag ?? null;
  const name = getFiberDisplayName(fiber);

  // If the fiber's stateNode is a real DOM node, obtain its capture id.
  let h2dId: string | undefined;
  if (fiber.stateNode instanceof Node) {
    h2dId = getNodeId(fiber.stateNode);
  }

  const props = fiber.memoizedProps
    ? serializeProps(fiber.memoizedProps as Record<string, unknown>)
    : undefined;

  // Walk the linked-list of child fibers.
  const children: SerializedFiberNode[] = [];
  let child = fiber.child;
  while (child) {
    const serialized = captureFiberNode(child, getNodeId);
    if (serialized) {
      children.push(serialized);
    }
    child = child.sibling;
  }

  return { h2dId, name, fiberTag, props, children };
}

/**
 * Serialize all entries of a props object.
 *
 * Each value is passed through formatPropValue which handles
 * truncation and reference replacement.
 */
function serializeProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    result[key] = formatPropValue(value);
  }
  return result;
}

/**
 * Serialize a single prop value for JSON-safe transport.
 *
 * - Primitives (`string`, `number`, `boolean`, `null`, `undefined`) are
 *   returned as-is, except strings longer than MAX_PROP_LENGTH which
 *   are truncated.
 * - Objects and functions are replaced with a stable `{ ref: "prop-ref-N" }`
 *   token via the propRefMap WeakMap.
 */
function formatPropValue(value: unknown): unknown {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    // Truncate long strings.
    if (typeof value === "string" && value.length > MAX_PROP_LENGTH) {
      return {
        truncated: true,
        value: value.slice(0, MAX_PROP_LENGTH),
        originalLength: value.length,
      } satisfies TruncatedPropValue;
    }
    return value;
  }

  // Objects and functions get a stable reference token.
  if (typeof value === "object" || typeof value === "function") {
    const target = value as object;
    let ref = propRefMap.get(target);
    if (!ref) {
      ref = `prop-ref-${++propRefCounter}`;
      propRefMap.set(target, ref);
    }
    return { ref } satisfies PropRefValue;
  }

  return undefined;
}

/**
 * Derive a human-readable display name from a React fiber.
 *
 * - Host components (tag 5) use `fiber.type` directly (e.g. `"div"`).
 * - Function / class components use `type.displayName ?? type.name`.
 * - Exotic types (ForwardRef, memo wrappers) use the wrapper object's
 *   `displayName` or `name`.
 */
function getFiberDisplayName(fiber: ReactFiber): string | undefined {
  if (typeof fiber.type === "string") {
    return fiber.type;
  }

  if (typeof fiber.type === "function") {
    const fn = fiber.type as { displayName?: string; name?: string };
    return fn.displayName ?? fn.name;
  }

  if (typeof fiber.type === "object" && fiber.type !== null) {
    const wrappedType = fiber.type as { displayName?: string; name?: string };
    return wrappedType.displayName ?? wrappedType.name;
  }

  return undefined;
}

/**
 * Walk up the fiber tree from `fiber` to find the nearest "meaningful"
 * wrapping component name.
 *
 * A component is considered meaningful when:
 * - Its tag is in COMPONENT_FIBER_TAGS.
 * - Its display name is at least 5 characters long.
 * - It does not match known generic wrapper patterns such as `Primitive.*`,
 *   `Styled.*`, `*Provider`, or HOC signatures like `Foo(Bar)`.
 *
 * The search stops when a HostComponent (tag 5) is encountered, or when
 * the current fiber has siblings (indicating the parent has multiple
 * children and is therefore not a simple wrapper).
 */
function findWrappingComponent(fiber: ReactFiber): string | null {
  let parent = fiber.return;
  let previous: ReactFiber = fiber;
  let candidate: string | null = null;

  while (parent) {
    // Stop at host (DOM) boundaries or when the child has siblings
    // (meaning we are no longer in a simple single-child wrapper chain).
    if (
      parent.tag === FIBER_TAGS.HostComponent ||
      parent.child !== previous ||
      previous.sibling != null
    ) {
      return candidate;
    }

    if (COMPONENT_FIBER_TAGS.has(parent.tag ?? -1)) {
      const name = getFiberDisplayName(parent);
      if (
        name &&
        /^.{5,}$/.test(name) &&
        !/^Primitive\./i.test(name) &&
        !/^Styled\./i.test(name) &&
        !/Provider$/i.test(name) &&
        name !== "__next_metadata_boundary__" &&
        !/^[a-zA-Z]+\(.*\)$/.test(name)
      ) {
        candidate = name;
      }
    }

    previous = parent;
    parent = parent.return;
  }

  return candidate;
}
