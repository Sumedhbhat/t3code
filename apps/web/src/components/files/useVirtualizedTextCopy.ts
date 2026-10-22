import { useEffect, useState } from "react";

import { VirtualizedTextSelectionTracker } from "./virtualizedTextCopy";
import { TextLineIndex } from "./virtualizedTextSelection";

/**
 * Makes copying from a virtualized read-only file view include the whole selection, also the
 * rows that are not mounted. Returns a ref callback for the element wrapping the view.
 */
export function useVirtualizedTextCopy(text: string): (element: HTMLElement | null) => void {
  const [wrapper, setWrapper] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (wrapper === null) return;
    const tracker = new VirtualizedTextSelectionTracker(wrapper, {
      lines: new TextLineIndex(text),
      content: (root) => root.querySelector("[data-content]"),
      lineOfRow: (row) => Number(row.dataset.line),
    });
    return () => tracker.dispose();
  }, [wrapper, text]);
  return setWrapper;
}
