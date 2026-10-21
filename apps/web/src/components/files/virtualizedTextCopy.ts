import {
  clipTextSelectionToLines,
  isCollapsedTextSelection,
  mergeObservedTextSelection,
  sameObservedSelection,
  type ObservedTextSelection,
  type RenderedLineRange,
  type TextPosition,
  type TextSelection,
  TextLineIndex,
} from "./virtualizedTextSelection";

type ShadowCaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
    options?: { shadowRoots: ShadowRoot[] },
  ) => CaretPosition | null;
};

type ComposedRangeSelection = Selection & {
  getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
  readonly direction?: "forward" | "backward" | "none";
};

const OUTSIDE = "outside";

function isPrimarySelectAll(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  );
}

/**
 * Tracks the selection of the read-only file view rendered inside `wrapper` as positions in the
 * file text, so selections that reach beyond the mounted rows copy completely. See
 * `virtualizedTextSelection.ts` for why the browser selection alone cannot do this.
 */
export interface VirtualizedTextSource {
  readonly lines: TextLineIndex;
  readonly content: (root: ShadowRoot) => Element | null;
  readonly lineOfRow: (row: HTMLElement) => number;
}

export class VirtualizedTextSelectionTracker {
  readonly #wrapper: HTMLElement;
  readonly #source: VirtualizedTextSource;
  readonly #disposers: Array<() => void> = [];
  #root: ShadowRoot | null = null;
  #rootObserver: MutationObserver | null = null;
  #selection: TextSelection | null = null;
  #pinnedAnchor: TextPosition | null = null;
  #applied: ObservedTextSelection | null = null;
  #pointerDown = false;
  #syncFrame: number | null = null;

  constructor(
    wrapper: HTMLElement,
    source: VirtualizedTextSource,
    keyboardTarget: EventTarget = wrapper,
  ) {
    this.#wrapper = wrapper;
    this.#source = source;
    this.#listen(wrapper, "pointerdown", this.#onPointerDown);
    this.#listen(keyboardTarget, "keydown", this.#onKeyDown);
    this.#listen(document, "pointerup", this.#onPointerUp);
    this.#listen(document, "pointercancel", this.#onPointerUp);
    this.#listen(document, "selectionchange", this.#onSelectionChange);
    // The copy event goes to the first visible text of the selection in the light DOM. The file
    // text lives in a shadow root, so that is usually an element after the wrapper.
    this.#listen(document, "copy", this.#onCopy);
    const wrapperObserver = new MutationObserver(() => this.#attachRoot());
    wrapperObserver.observe(wrapper, { childList: true, subtree: true });
    this.#disposers.push(() => wrapperObserver.disconnect());
    this.#attachRoot();
  }

  dispose(): void {
    for (const dispose of this.#disposers) dispose();
    this.#rootObserver?.disconnect();
    if (this.#syncFrame !== null) cancelAnimationFrame(this.#syncFrame);
  }

  #listen<E extends Event>(target: EventTarget, type: string, listener: (event: E) => void): void {
    const handler = (event: Event) => listener(event as E);
    target.addEventListener(type, handler);
    this.#disposers.push(() => target.removeEventListener(type, handler));
  }

  #attachRoot(): void {
    const host = this.#wrapper.matches("diffs-container")
      ? this.#wrapper
      : this.#wrapper.querySelector("diffs-container");
    const root = host?.shadowRoot ?? null;
    if (root === this.#root) return;
    this.#rootObserver?.disconnect();
    this.#root = root;
    this.#selection = null;
    this.#pinnedAnchor = null;
    if (root === null) return;
    // Rows are mounted and unmounted as the view scrolls. Re-highlight the mounted part of the
    // selection each time, since the browser cannot keep newly mounted rows selected.
    this.#rootObserver = new MutationObserver(() => this.#scheduleSync());
    this.#rootObserver.observe(root, { childList: true, subtree: true });
  }

  #content(): Element | null {
    return this.#root === null ? null : this.#source.content(this.#root);
  }

  #positionOf(node: Node, offset: number, content: Element): TextPosition | null {
    const element = node instanceof Element ? node : node.parentElement;
    const row = element?.closest<HTMLElement>("[data-line]");
    if (!row || row.parentElement !== content) return null;
    const line = this.#source.lineOfRow(row);
    if (!Number.isInteger(line)) return null;
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(node, offset);
    return { line, character: range.toString().length };
  }

  #positionAtPoint(x: number, y: number): TextPosition | null {
    const root = this.#root;
    const content = this.#content();
    if (root === null || content === null) return null;
    const caret = (document as ShadowCaretDocument).caretPositionFromPoint?.(x, y, {
      shadowRoots: [root],
    });
    return caret ? this.#positionOf(caret.offsetNode, caret.offset, content) : null;
  }

  /**
   * Maps the browser selection onto the file, reports that it is elsewhere in the page, or
   * returns `null` when there is nothing to learn from it.
   */
  #observe(): ObservedTextSelection | typeof OUTSIDE | null {
    const root = this.#root;
    const content = this.#content();
    const selection = document.getSelection() as ComposedRangeSelection | null;
    if (root === null || content === null || selection === null) return OUTSIDE;
    // The browser drops the selection when a click lands inside the highlighted text.
    if (selection.rangeCount === 0) return null;
    if (typeof selection.getComposedRanges !== "function") return null;
    const range = selection.getComposedRanges({ shadowRoots: [root] })[0];
    if (!range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return OUTSIDE;
    }
    const start = this.#positionOf(range.startContainer, range.startOffset, content);
    const end = this.#positionOf(range.endContainer, range.endOffset, content);
    return selection.direction === "backward"
      ? { anchor: end, focus: start }
      : { anchor: start, focus: end };
  }

  #renderedLines(content: Element): RenderedLineRange | null {
    const rows = content.querySelectorAll<HTMLElement>(":scope > [data-line]");
    const first = rows[0] ? this.#source.lineOfRow(rows[0]) : NaN;
    const lastRow = rows[rows.length - 1];
    const last = lastRow ? this.#source.lineOfRow(lastRow) : NaN;
    if (!Number.isInteger(first) || !Number.isInteger(last)) return null;
    return { first, last };
  }

  #pointFor(position: TextPosition, content: Element): [Node, number] | null {
    const row = Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-line]")).find(
      (row) => this.#source.lineOfRow(row) === position.line,
    );
    if (!row) return null;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let remaining = position.character;
    let last: Text | null = null;
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      if (remaining <= node.length) return [node, remaining];
      remaining -= node.length;
      last = node;
    }
    return last === null ? [row, 0] : [last, last.length];
  }

  /** Selects the mounted part of the tracked selection in the browser. */
  #highlight(): void {
    const content = this.#content();
    const selection = this.#selection;
    if (content === null || selection === null) return;
    const rendered = this.#renderedLines(content);
    const clipped =
      rendered === null
        ? null
        : clipTextSelectionToLines(selection, rendered, (line) =>
            this.#source.lines.lineLength(line),
          );
    if (clipped === null) return;
    const anchor = this.#pointFor(clipped.anchor, content);
    const focus = this.#pointFor(clipped.focus, content);
    if (anchor === null || focus === null) return;
    this.#applied = { anchor: clipped.anchor, focus: clipped.focus };
    document.getSelection()?.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
  }

  #scheduleSync(): void {
    if (this.#syncFrame !== null) return;
    this.#syncFrame = requestAnimationFrame(() => {
      this.#syncFrame = null;
      const selection = this.#selection;
      if (this.#pointerDown || selection === null || isCollapsedTextSelection(selection)) return;
      if (this.#observe() === OUTSIDE) return;
      this.#highlight();
    });
  }

  readonly #onPointerDown = (event: PointerEvent) => {
    this.#pointerDown = true;
    // Shift+click extends the tracked selection from its anchor. A plain click starts a new
    // selection where it lands, which is recorded here because the browser does not always
    // report it.
    if (event.shiftKey) {
      this.#pinnedAnchor = this.#selection?.anchor ?? this.#pinnedAnchor;
      return;
    }
    const anchor = this.#positionAtPoint(event.clientX, event.clientY);
    this.#pinnedAnchor = anchor;
    this.#selection = anchor === null ? null : { anchor, focus: anchor };
  };

  readonly #onPointerUp = () => {
    if (!this.#pointerDown) return;
    this.#pointerDown = false;
    this.#scheduleSync();
  };

  readonly #onKeyDown = (event: KeyboardEvent) => {
    if (!isPrimarySelectAll(event) || this.#content() === null) return;
    if (
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLElement &&
            (target.isContentEditable || target.matches("input, textarea, select")),
        )
    )
      return;
    if (this.#observe() === OUTSIDE) return;
    event.preventDefault();
    this.#selection = this.#source.lines.fullSelection();
    this.#pinnedAnchor = this.#selection.anchor;
    this.#highlight();
  };

  readonly #onSelectionChange = () => {
    const observed = this.#observe();
    if (observed === null) return;
    if (observed === OUTSIDE) {
      // While dragging past the edge of the view the selection briefly reaches into the
      // surrounding page; the drag is still extending the tracked selection.
      if (this.#pointerDown) return;
      this.#selection = null;
      this.#pinnedAnchor = null;
      return;
    }
    // Ignore the change caused by highlighting the mounted part of the tracked selection.
    if (sameObservedSelection(observed, this.#applied)) return;
    this.#applied = null;
    const content = this.#content();
    this.#selection = mergeObservedTextSelection(
      this.#selection,
      observed,
      content === null ? null : this.#renderedLines(content),
      this.#pinnedAnchor,
    );
  };

  readonly #onCopy = (event: ClipboardEvent) => {
    const selection = this.#selection;
    if (selection === null || isCollapsedTextSelection(selection) || event.clipboardData === null) {
      return;
    }
    if (this.#observe() === OUTSIDE) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", this.#source.lines.textOf(selection));
  };
}
