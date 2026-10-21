import {
  parseDiffFromFile,
  parsePatchFiles,
  type FileDiffContentsLoader,
  type FileDiffLoadedFiles,
} from "@pierre/diffs";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { StyledDiffCodeView } from "./StyledDiffCodeView";
import { diffTextForCopy } from "./diffTextForCopy";

const before = Array.from({ length: 600 }, (_, i) => `old line ${i + 1}\n`).join("");
const after = Array.from({ length: 600 }, (_, i) => `new line ${i + 1}\n`).join("");
const diff = parseDiffFromFile(
  { name: "big.txt", contents: before },
  { name: "big.txt", contents: after },
);

describe("copying from virtualized diffs", () => {
  async function mount(
    style: "split" | "unified",
    fileDiff = diff,
    loadDiffFiles?: FileDiffContentsLoader,
  ) {
    await page.viewport(1100, 800);
    await using stack = new AsyncDisposableStack();
    const container = document.createElement("div");
    container.style.cssText = "display:flex;flex-direction:column;height:300px;width:900px";
    stack.use(
      await render(
        <StyledDiffCodeView
          items={[{ type: "diff", id: "big", fileDiff }]}
          className="min-h-0 flex-1 overflow-auto"
          options={{
            diffStyle: style,
            theme: "pierre-dark",
            ...(loadDiffFiles ? { loadDiffFiles } : {}),
          }}
        />,
        { container },
      ),
    );
    const shadow = await vi.waitFor(
      () => {
        const root = container.querySelector("diffs-container")?.shadowRoot;
        if (!root?.querySelector("[data-content] > [data-line]")) throw new Error("not rendered");
        return root;
      },
      { timeout: 10_000 },
    );
    return Object.assign(stack.move(), { container, shadow });
  }
  async function copy(): Promise<string | null> {
    let text: string | null = null;
    const listener = (event: ClipboardEvent) => {
      text = event.defaultPrevented ? (event.clipboardData?.getData("text/plain") ?? "") : null;
    };
    document.addEventListener("copy", listener);
    try {
      await userEvent.keyboard("{Control>}c{/Control}");
    } finally {
      document.removeEventListener("copy", listener);
    }
    return text;
  }
  it.each(["additions", "deletions"] as const)(
    "copies all 600 lines from the %s column",
    async (column) => {
      await using view = await mount("split");
      const { shadow } = view;
      const rows = shadow.querySelectorAll<HTMLElement>(
        `[data-${column}] [data-content] > [data-line]`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(600);
      await userEvent.click(rows[0]!);
      await userEvent.keyboard("{Control>}a{/Control}");
      expect(await copy()).toBe(column === "additions" ? after : before);
      await userEvent.click(rows[1]!);
      expect(await copy()).toBeNull();
    },
  );
  it.each([
    ["split", "additions"],
    ["split", "deletions"],
    ["unified", "unified"],
  ] as const)("copies exactly 400 selected lines in %s/%s", async (style, column) => {
    await using view = await mount(style);
    const { shadow, container } = view;
    const selector = `[data-${column}] [data-content] > [data-line]`;
    const first = shadow.querySelector<HTMLElement>(selector)!;
    await userEvent.click(first.querySelector("span")!, { position: { x: 1, y: 8 } });
    const scroller = container.querySelector<HTMLElement>(".diff-render-surface")!;
    scroller.scrollTop = 390 * 20;
    const last = await vi.waitFor(() => {
      const row = shadow.querySelector<HTMLElement>(`${selector}[data-line="400"]`);
      if (!row) throw new Error("line 400 not rendered");
      return row;
    });
    expect(first.isConnected).toBe(false);
    last.scrollIntoView({ block: "center", inline: "nearest" });
    await vi.waitFor(() => expect(getComputedStyle(last).pointerEvents).not.toBe("none"));
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(last);
    await userEvent.keyboard("{/Shift}");
    const source = column === "additions" ? after : before;
    expect(await copy()).toBe(source.split("\n").slice(0, 400).join("\n"));
  });
  it("copies 400 lines across deletions and additions in unified view", async () => {
    const oldText = before.split("\n").slice(0, 200).join("\n") + "\n";
    const newText = after.split("\n").slice(0, 400).join("\n") + "\n";
    const model = parseDiffFromFile(
      { name: "big.txt", contents: oldText },
      { name: "big.txt", contents: newText },
    );
    await using view = await mount("unified", model);
    const { shadow, container } = view;
    const first = shadow.querySelector<HTMLElement>(
      '[data-content] > [data-line-type="change-deletion"][data-line="1"]',
    )!;
    await userEvent.click(first.querySelector("span")!, { position: { x: 1, y: 8 } });
    const scroller = container.querySelector<HTMLElement>(".diff-render-surface")!;
    scroller.scrollTop = 390 * 20;
    const last = await vi.waitFor(() => {
      const row = shadow.querySelector<HTMLElement>(
        '[data-content] > [data-line-type="change-addition"][data-line="200"]',
      );
      if (!row) throw new Error("selected row not rendered");
      return row;
    });
    expect(first.isConnected).toBe(false);
    last.scrollIntoView({ block: "center", inline: "nearest" });
    await vi.waitFor(() => expect(getComputedStyle(last).pointerEvents).not.toBe("none"));
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(last);
    await userEvent.keyboard("{/Shift}");
    expect(await copy()).toBe(oldText + after.split("\n").slice(0, 200).join("\n"));
  });
  it("keeps the full selection after scrolling replaces the mounted rows", async () => {
    await using view = await mount("split");
    const { shadow, container } = view;
    const first = shadow.querySelector<HTMLElement>(
      "[data-additions] [data-content] > [data-line]",
    )!;
    await userEvent.click(first);
    await userEvent.keyboard("{Control>}a{/Control}");
    const scroller = container.querySelector<HTMLElement>(".diff-render-surface")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => {
      expect(first.isConnected).toBe(false);
      expect(shadow.querySelector('[data-additions] [data-line="600"]')).not.toBeNull();
    });
    expect(await copy()).toBe(after);
  });
  it("copies additions and deletions in unified order without gutter numbers", async () => {
    await using view = await mount("unified");
    const { shadow } = view;
    const row = shadow.querySelector<HTMLElement>("[data-content] > [data-line]")!;
    await userEvent.click(row);
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(await copy()).toBe(before + after);
  });
  it("copies a partial patch without requiring full-file hydration", async () => {
    const patch = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -10,600 +10,600 @@\n${before
      .split("\n")
      .slice(0, -1)
      .map((line) => `-${line}\n`)
      .join("")}${after
      .split("\n")
      .slice(0, -1)
      .map((line) => `+${line}\n`)
      .join("")}`;
    const partial = parsePatchFiles(patch)[0]!.files[0]!;
    expect(partial.isPartial).toBe(true);
    await using view = await mount("split", partial);
    const { shadow } = view;
    await userEvent.click(
      shadow.querySelector<HTMLElement>("[data-additions] [data-content] > [data-line]")!,
    );
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(await copy()).toBe(after);
  });
  it("refreshes the copy source when a partial diff is hydrated in place", async () => {
    const prefix = Array.from({ length: 10 }, (_, i) => `unchanged ${i + 1}\n`).join("");
    const oldFile = { name: "big.txt", contents: prefix + "old line 11\n" };
    const newFile = { name: "big.txt", contents: prefix + "new line 11\n" };
    const partial = parsePatchFiles(
      "diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -11 +11 @@\n-old line 11\n+new line 11\n",
    )[0]!.files[0]!;
    let resolveFiles!: (files: FileDiffLoadedFiles) => void;
    const files = new Promise<FileDiffLoadedFiles>((resolve) => {
      resolveFiles = resolve;
    });
    const loadFiles = vi.fn(() => files);
    await using view = await mount("split", partial, loadFiles);
    const { shadow } = view;
    await userEvent.click(page.getByRole("button").first());
    expect(loadFiles).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByText("new line 11", { exact: true }));
    await userEvent.keyboard("{Control>}a{/Control}");
    expect((await copy())?.trimEnd()).toBe("new line 11");
    resolveFiles({ oldFile, newFile });
    await vi.waitFor(() =>
      expect(
        shadow.querySelector('[data-additions] [data-content] > [data-line="10"]'),
      ).not.toBeNull(),
    );
    await userEvent.click(page.getByText("new line 11", { exact: true }));
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(await copy()).toBe(newFile.contents);
  });
  it("keeps native copy after selecting text elsewhere", async () => {
    await using view = await mount("split");
    const { shadow, container } = view;
    await userEvent.click(
      shadow.querySelector<HTMLElement>("[data-additions] [data-content] > [data-line]")!,
    );
    await userEvent.keyboard("{Control>}a{/Control}");
    const other = document.createElement("p");
    other.textContent = "some other text";
    container.append(other);
    const range = document.createRange();
    range.selectNodeContents(other);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(await copy()).toBeNull();
  });
});

describe("diff text for copying", () => {
  it("preserves context, both changes and missing final newline", () => {
    const oldText = "start\nold\nend";
    const newText = "start\nnew\nend";
    const model = parseDiffFromFile(
      { name: "a.txt", contents: oldText },
      { name: "a.txt", contents: newText },
    );
    expect(diffTextForCopy(model, "additions")).toBe(newText);
    expect(diffTextForCopy(model, "deletions")).toBe(oldText);
    expect(diffTextForCopy(model, "unified")).toBe("start\nold\nnew\nend");
  });
});
