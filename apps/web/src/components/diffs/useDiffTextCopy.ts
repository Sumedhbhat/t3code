import type { FileDiffMetadata, File, FileDiff, PostRenderPhase } from "@pierre/diffs";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { VirtualizedTextSelectionTracker } from "../files/virtualizedTextCopy";

import { buildDiffTextSource, type CopyColumn } from "./diffTextForCopy";

class DiffTextCopy {
  #column: CopyColumn | null = null;
  #tracker: VirtualizedTextSelectionTracker | null = null;
  #diff: FileDiffMetadata;
  readonly #host: HTMLElement;

  constructor(host: HTMLElement, diff: FileDiffMetadata) {
    this.#host = host;
    this.#diff = { ...diff };
    document.addEventListener("pointerdown", this.#onPointerDown, true);
  }

  update(diff: FileDiffMetadata): void {
    if (
      this.#diff.additionLines !== diff.additionLines ||
      this.#diff.deletionLines !== diff.deletionLines ||
      this.#diff.hunks !== diff.hunks ||
      this.#diff.isPartial !== diff.isPartial
    ) {
      this.#reset();
      this.#diff = { ...diff };
    }
  }

  #reset(): void {
    this.#tracker?.dispose();
    this.#tracker = null;
    this.#column = null;
  }

  dispose(): void {
    this.#reset();
    document.removeEventListener("pointerdown", this.#onPointerDown, true);
  }

  readonly #onPointerDown = (event: PointerEvent) => {
    for (const target of event.composedPath()) {
      if (!(target instanceof Element) || target.getRootNode() !== this.#host.shadowRoot) continue;
      const code = target.closest("[data-code]");
      if (!code || !target.closest("[data-content] > [data-line]")) continue;
      const column = code.hasAttribute("data-deletions")
        ? "deletions"
        : code.hasAttribute("data-additions")
          ? "additions"
          : "unified";
      if (column !== this.#column) {
        this.#reset();
        this.#column = column;
        this.#tracker = new VirtualizedTextSelectionTracker(
          this.#host,
          buildDiffTextSource(this.#diff, column),
          document,
        );
      }
      return;
    }
    this.#reset();
  };
}

export function useDiffTextCopy<LAnnotation>() {
  const [trackers] = useState(() => new Map<HTMLElement, DiffTextCopy>());
  useEffect(
    () => () => {
      for (const tracker of trackers.values()) tracker.dispose();
      trackers.clear();
    },
    [trackers],
  );
  return useStableCallback(
    (
      node: HTMLElement,
      instance: File<LAnnotation> | FileDiff<LAnnotation>,
      phase: PostRenderPhase,
      context: { item: { edit?: boolean } },
    ) => {
      if (
        phase === "unmount" ||
        context.item.edit ||
        !("fileDiff" in instance) ||
        !instance.fileDiff
      ) {
        trackers.get(node)?.dispose();
        trackers.delete(node);
        return;
      }
      const tracker = trackers.get(node);
      if (tracker) tracker.update(instance.fileDiff);
      else trackers.set(node, new DiffTextCopy(node, instance.fileDiff));
    },
  );
}
