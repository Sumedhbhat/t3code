/**
 * A virtualized file view only mounts the rows near the viewport, so the browser selection can
 * only ever reference those rows. When a row holding one end of the selection is unmounted, the
 * browser moves that end onto the row container, and copying then yields only the mounted part.
 *
 * These helpers keep the selection as line/character positions in the file text instead, so it
 * survives rows being unmounted and copying can read the full selected range from the text.
 */

/** A position in the file text. `line` is 1-based, matching the `data-line` row attribute. */
export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

export interface TextSelection {
  readonly anchor: TextPosition;
  readonly focus: TextPosition;
}

/**
 * A browser selection mapped onto the file. An end is `null` when it does not sit on a mounted
 * row, which is where the browser leaves an end whose row was unmounted.
 */
export interface ObservedTextSelection {
  readonly anchor: TextPosition | null;
  readonly focus: TextPosition | null;
}

export interface RenderedLineRange {
  readonly first: number;
  readonly last: number;
}

function compareTextPositions(a: TextPosition, b: TextPosition): number {
  return a.line - b.line || a.character - b.character;
}

function samePosition(a: TextPosition | null, b: TextPosition | null): boolean {
  if (a === null || b === null) return a === b;
  return compareTextPositions(a, b) === 0;
}

export function sameObservedSelection(
  a: ObservedTextSelection | null,
  b: ObservedTextSelection | null,
): boolean {
  if (a === null || b === null) return a === b;
  return samePosition(a.anchor, b.anchor) && samePosition(a.focus, b.focus);
}

export function isCollapsedTextSelection(selection: TextSelection): boolean {
  return compareTextPositions(selection.anchor, selection.focus) === 0;
}

function orderTextSelection(selection: TextSelection): {
  readonly start: TextPosition;
  readonly end: TextPosition;
} {
  return compareTextPositions(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

function isLineRendered(line: number, rendered: RenderedLineRange | null): boolean {
  return rendered !== null && line >= rendered.first && line <= rendered.last;
}

/**
 * Combines the selection the browser reports with what is known from before: the previous
 * selection, and the anchor pinned by the pointer gesture that started or extended it.
 *
 * The focus is the end the user moves, so the browser's focus wins whenever it is on a mounted
 * row. The browser's anchor is not trusted when
 * - the pinned anchor's row is not mounted: the browser moved its anchor when the row was
 *   unmounted (it snaps to the first mounted row once the selection is extended), or
 * - the browser reports a collapsed selection: it dropped the selection, as it does when a click
 *   lands inside the highlighted text, and a Shift+click then starts from nothing.
 *
 * Returns `null` when an end is unknown and there is nothing remembered to fill it in.
 */
export function mergeObservedTextSelection(
  previous: TextSelection | null,
  observed: ObservedTextSelection,
  rendered: RenderedLineRange | null,
  pinnedAnchor: TextPosition | null,
): TextSelection | null {
  const observedIsCollapsed =
    observed.anchor !== null &&
    observed.focus !== null &&
    compareTextPositions(observed.anchor, observed.focus) === 0;
  const anchor =
    pinnedAnchor !== null &&
    (observed.anchor === null ||
      observedIsCollapsed ||
      !isLineRendered(pinnedAnchor.line, rendered))
      ? pinnedAnchor
      : observed.anchor;
  const focus = observed.focus ?? previous?.focus ?? null;
  if (anchor === null || focus === null) return null;
  return { anchor, focus };
}

/**
 * Limits a selection to the mounted rows so the browser can highlight that part, keeping its
 * direction. Returns `null` when no mounted row is selected.
 */
export function clipTextSelectionToLines(
  selection: TextSelection,
  rendered: RenderedLineRange,
  lineLength: (line: number) => number,
): TextSelection | null {
  const { start, end } = orderTextSelection(selection);
  if (end.line < rendered.first || start.line > rendered.last) return null;
  const clippedStart = start.line < rendered.first ? { line: rendered.first, character: 0 } : start;
  const clippedEnd =
    end.line > rendered.last ? { line: rendered.last, character: lineLength(rendered.last) } : end;
  if (compareTextPositions(clippedStart, clippedEnd) >= 0) return null;
  const forward = compareTextPositions(selection.anchor, selection.focus) <= 0;
  return forward
    ? { anchor: clippedStart, focus: clippedEnd }
    : { anchor: clippedEnd, focus: clippedStart };
}

/** Indexes the lines of a file text the way the file view numbers its rows. */
export class TextLineIndex {
  readonly text: string;
  readonly #lineStarts: number[];

  constructor(text: string) {
    this.text = text;
    const lineStarts = [0];
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      lineStarts.push(index + 1);
    }
    this.#lineStarts = lineStarts;
  }

  get lineCount(): number {
    return this.#lineStarts.length;
  }

  /** The length of a line without its line break, including a `\r` before `\n`. */
  lineLength(line: number): number {
    const start = this.#lineStarts[line - 1];
    if (start === undefined) return 0;
    const next = this.#lineStarts[line];
    let end = next === undefined ? this.text.length : next - 1;
    if (end > start && this.text[end - 1] === "\r") end -= 1;
    return end - start;
  }

  offsetOf(position: TextPosition): number {
    const line = Math.min(Math.max(position.line, 1), this.lineCount);
    const start = this.#lineStarts[line - 1] ?? 0;
    return start + Math.min(Math.max(position.character, 0), this.lineLength(line));
  }

  fullSelection(): TextSelection {
    return {
      anchor: { line: 1, character: 0 },
      focus: { line: this.lineCount, character: this.lineLength(this.lineCount) },
    };
  }

  textOf(selection: TextSelection): string {
    const { start, end } = orderTextSelection(selection);
    return this.text.slice(this.offsetOf(start), this.offsetOf(end));
  }
}
