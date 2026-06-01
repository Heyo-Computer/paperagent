// preact/compat has no `react-dom/client` entry. BlockNote/Mantine use
// `createRoot(container).render(...)` to mount node views; map it onto preact's
// `render`. Good enough for the imperative roots BlockNote creates.
import { render, hydrate } from "preact/compat";

export function createRoot(container) {
  return {
    render(children) {
      render(children, container);
    },
    unmount() {
      render(null, container);
    },
  };
}

export function hydrateRoot(container, children) {
  hydrate(children, container);
  return {
    render(c) {
      render(c, container);
    },
    unmount() {
      render(null, container);
    },
  };
}

export default { createRoot, hydrateRoot };
