import { describe, expect, it } from "vite-plus/test";

import {
  clipTextSelectionToLines,
  mergeObservedTextSelection,
  TextLineIndex,
} from "./virtualizedTextSelection";

const lines = Array.from({ length: 600 }, (_, index) => `local line_${index + 1} = ${index + 1}`);
const index = new TextLineIndex(`${lines.join("\n")}\n`);

describe("TextLineIndex", () => {
  it("reads a multi-line range from the text", () => {
    expect(
      index.textOf({ anchor: { line: 1, character: 0 }, focus: { line: 500, character: 0 } }),
    ).toBe(`${lines.slice(0, 499).join("\n")}\n`);
  });

  it("reads a range selected backwards", () => {
    expect(
      index.textOf({ anchor: { line: 3, character: 5 }, focus: { line: 2, character: 6 } }),
    ).toBe("line_2 = 2\nlocal");
  });

  it("selects the whole text, including a trailing line break", () => {
    expect(index.textOf(index.fullSelection())).toBe(index.text);
  });

  it("excludes a carriage return from line lengths", () => {
    const crlf = new TextLineIndex("ab\r\ncd");
    expect(crlf.lineLength(1)).toBe(2);
    expect(crlf.textOf(crlf.fullSelection())).toBe("ab\r\ncd");
  });
});

describe("mergeObservedTextSelection", () => {
  const previous = { anchor: { line: 1, character: 0 }, focus: { line: 40, character: 3 } };
  const top = { first: 1, last: 100 };
  const scrolledDown = { first: 351, last: 550 };

  it("keeps the remembered anchor when the browser lost it to unmounting", () => {
    expect(
      mergeObservedTextSelection(
        previous,
        { anchor: null, focus: { line: 500, character: 0 } },
        scrolledDown,
        previous.anchor,
      ),
    ).toEqual({ anchor: { line: 1, character: 0 }, focus: { line: 500, character: 0 } });
  });

  it("keeps the remembered anchor when the browser snapped it to the first mounted row", () => {
    expect(
      mergeObservedTextSelection(
        previous,
        { anchor: { line: 351, character: 0 }, focus: { line: 500, character: 0 } },
        scrolledDown,
        previous.anchor,
      ),
    ).toEqual({ anchor: { line: 1, character: 0 }, focus: { line: 500, character: 0 } });
  });

  it("takes both ends from the browser when the remembered anchor is mounted", () => {
    const observed = { anchor: { line: 7, character: 1 }, focus: { line: 9, character: 2 } };
    expect(mergeObservedTextSelection(previous, observed, top, previous.anchor)).toEqual(observed);
  });

  it("keeps the pinned anchor when the browser dropped the selection before a Shift+click", () => {
    expect(
      mergeObservedTextSelection(
        { anchor: { line: 10, character: 0 }, focus: { line: 10, character: 0 } },
        { anchor: { line: 14, character: 0 }, focus: { line: 14, character: 0 } },
        top,
        { line: 10, character: 0 },
      ),
    ).toEqual({ anchor: { line: 10, character: 0 }, focus: { line: 14, character: 0 } });
  });

  it("gives up when an end is unknown and nothing is remembered", () => {
    expect(
      mergeObservedTextSelection(
        null,
        { anchor: null, focus: { line: 5, character: 0 } },
        top,
        null,
      ),
    ).toBeNull();
  });
});

describe("clipTextSelectionToLines", () => {
  const lineLength = (line: number) => index.lineLength(line);

  it("limits a selection to the mounted rows", () => {
    expect(
      clipTextSelectionToLines(
        { anchor: { line: 1, character: 0 }, focus: { line: 500, character: 4 } },
        { first: 351, last: 450 },
        lineLength,
      ),
    ).toEqual({
      anchor: { line: 351, character: 0 },
      focus: { line: 450, character: lineLength(450) },
    });
  });

  it("keeps the direction of a backward selection", () => {
    expect(
      clipTextSelectionToLines(
        { anchor: { line: 500, character: 4 }, focus: { line: 1, character: 0 } },
        { first: 351, last: 450 },
        lineLength,
      ),
    ).toEqual({
      anchor: { line: 450, character: lineLength(450) },
      focus: { line: 351, character: 0 },
    });
  });

  it("returns null when no mounted row is selected", () => {
    expect(
      clipTextSelectionToLines(
        { anchor: { line: 1, character: 0 }, focus: { line: 50, character: 0 } },
        { first: 351, last: 450 },
        lineLength,
      ),
    ).toBeNull();
  });
});
