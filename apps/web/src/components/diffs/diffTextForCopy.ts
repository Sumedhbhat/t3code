import type { FileDiffMetadata } from "@pierre/diffs";

import type { VirtualizedTextSource } from "../files/virtualizedTextCopy";
import { TextLineIndex } from "../files/virtualizedTextSelection";

export type CopyColumn = "additions" | "deletions" | "unified";

/** Diff line numbers can repeat across sides, and partial patches omit the gaps between hunks. */
export function buildDiffTextSource(
  diff: FileDiffMetadata,
  column: CopyColumn,
): VirtualizedTextSource {
  const positions = new Map<string, number>();
  const lines: string[] = [];
  const append = (side: "additions" | "deletions", index: number, count: number, start: number) => {
    const source = side === "additions" ? diff.additionLines : diff.deletionLines;
    for (let offset = 0; offset < count; offset++) {
      positions.set(`${side}:${start + offset}`, lines.length + 1);
      lines.push(source[index + offset] ?? "");
    }
  };
  if (column !== "unified") {
    const source = column === "additions" ? diff.additionLines : diff.deletionLines;
    if (!diff.isPartial) append(column, 0, source.length, 1);
    else
      for (const hunk of diff.hunks) {
        if (column === "additions")
          append(column, hunk.additionLineIndex, hunk.additionCount, hunk.additionStart);
        else append(column, hunk.deletionLineIndex, hunk.deletionCount, hunk.deletionStart);
      }
  } else {
    let nextAddition = 0;
    for (const hunk of diff.hunks) {
      if (!diff.isPartial)
        append("additions", nextAddition, hunk.additionLineIndex - nextAddition, nextAddition + 1);
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          append(
            "additions",
            content.additionLineIndex,
            content.lines,
            hunk.additionStart + content.additionLineIndex - hunk.additionLineIndex,
          );
        } else {
          append(
            "deletions",
            content.deletionLineIndex,
            content.deletions,
            hunk.deletionStart + content.deletionLineIndex - hunk.deletionLineIndex,
          );
          append(
            "additions",
            content.additionLineIndex,
            content.additions,
            hunk.additionStart + content.additionLineIndex - hunk.additionLineIndex,
          );
        }
      }
      nextAddition = hunk.additionLineIndex + hunk.additionCount;
    }
    if (!diff.isPartial)
      append("additions", nextAddition, diff.additionLines.length - nextAddition, nextAddition + 1);
  }
  // Each rendered row is a line even when an old EOF line precedes a replacement without a newline.
  const text = lines
    .map((line, index) => (index < lines.length - 1 && !line.endsWith("\n") ? `${line}\n` : line))
    .join("");
  return {
    lines: new TextLineIndex(text),
    content: (root) => root.querySelector(`[data-${column}] > [data-content]`),
    lineOfRow: (row) => {
      const side =
        column === "unified"
          ? row.dataset.lineType === "change-deletion"
            ? "deletions"
            : "additions"
          : column;
      return positions.get(`${side}:${row.dataset.line}`) ?? NaN;
    },
  };
}

export function diffTextForCopy(diff: FileDiffMetadata, column: CopyColumn): string {
  return buildDiffTextSource(diff, column).lines.text;
}
