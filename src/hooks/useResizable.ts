import { useCallback } from "preact/hooks";

/**
 * Generalised horizontal drag-resize, mirroring the hand-rolled pattern in
 * App.tsx: attach document mousemove/mouseup on pointer-down, set the body
 * cursor, and report movement. Two usage shapes are supported:
 *
 *  - "owns a width": pass `onDelta` that adds the dx to a stored width.
 *  - "reports deltas": same callback; the caller decides what the delta means
 *    (e.g. a single table column).
 *
 * `cursor` defaults to col-resize. The returned `onMouseDown` is stable.
 */
export function useResizable(
  onDelta: (dx: number) => void,
  cursor: string = "col-resize",
) {
  return useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      let lastX = startX;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        if (dx !== 0) onDelta(dx);
      };

      const onMouseUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [onDelta, cursor],
  );
}
