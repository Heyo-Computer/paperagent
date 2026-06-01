// Plain JS (tsc ignores it; esbuild/rollup bundle it) so we can re-export all of
// preact/compat — which uses `export =` and can't be `export *`-ed from TS.
//
// preact/compat lacks React 19's `use` hook that Mantine v8 (via BlockNote)
// imports as `{ use } from "react"`. Mantine only calls `use(Context)`, which
// is equivalent to `useContext`, so we shim it.
import { useContext, useRef, useCallback } from "preact/compat";

export * from "preact/compat";
export { default } from "preact/compat";

export const use = (resource) => useContext(resource);

// React's experimental `useEffectEvent` — a stable callback that always sees the
// latest closure. Mantine hooks import it; preact/compat doesn't ship it.
export function useEffectEvent(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args) => ref.current?.(...args), []);
}

// React 19.2 experimental `<Activity>` — shows/hides children while preserving
// state. Mantine's Collapse imports it; approximate by hiding when not visible.
export function Activity(props) {
  return props && props.mode === "hidden" ? null : props.children;
}
