import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";

import ReadOnlySourcePreview from "./ReadOnlySourcePreview";

const LINE_COUNT = 400;
const lines = Array.from(
  { length: LINE_COUNT },
  (_, index) => `const line${index + 1} = ${index + 1};`,
);
const text = lines.join("\n");

describe("copying from a virtualized file view", () => {
  async function renderView(view: ReactNode) {
    await page.viewport(1100, 800);
    await using stack = new AsyncDisposableStack();
    const container = document.createElement("div");
    container.style.cssText = "display:flex;flex-direction:column;height:300px;width:600px";
    stack.use(await render(view, { container }));
    const shadowRoot = await vi.waitFor(
      () => {
        const root = container.querySelector("diffs-container")?.shadowRoot;
        if (!root?.querySelector("[data-line]")) throw new Error("not rendered");
        return root;
      },
      { timeout: 10_000 },
    );
    return Object.assign(stack.move(), { container, shadowRoot });
  }

  function mountedRowCount(shadowRoot: ShadowRoot): number {
    return shadowRoot.querySelectorAll("[data-content] > [data-line]").length;
  }

  function row(shadowRoot: ShadowRoot, line: number): HTMLElement | null {
    return shadowRoot.querySelector(`[data-content] > [data-line="${line}"]`);
  }

  /** Copies and returns the text the view put on the clipboard, or `null` if it left it alone. */
  async function copy(): Promise<string | null> {
    let copied: string | null = null;
    document.addEventListener(
      "copy",
      (event) => {
        copied = event.defaultPrevented ? (event.clipboardData?.getData("text/plain") ?? "") : null;
      },
      { once: true },
    );
    await userEvent.keyboard("{Control>}c{/Control}");
    return copied;
  }

  it("copies the whole file after Select All although only some rows are mounted", async () => {
    await using view = await renderView(<ReadOnlySourcePreview name="big.ts" text={text} />);
    const { shadowRoot } = view;
    expect(mountedRowCount(shadowRoot)).toBeLessThan(LINE_COUNT);
    await userEvent.click(row(shadowRoot, 1)!);
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(await copy()).toBe(text);
  });

  it.each([false, true])(
    "copies exactly 400 selected lines out of a 600-line file (editable: %s)",
    async (editable) => {
      const allLines = Array.from({ length: 600 }, (_, i) => `local line_${i + 1} = ${i + 1}`);
      const content = allLines.join("\n");
      await using view = await renderView(
        editable ? (
          <DiffWorkerPoolProvider>
            <EditProvider createEditor={(type, options, key) => new Editor(type, options, key)}>
              <Virtualizer
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
              >
                <File
                  file={{ name: "big.lua", contents: content }}
                  edit
                  options={{ disableFileHeader: true }}
                  className="min-h-full"
                />
              </Virtualizer>
            </EditProvider>
          </DiffWorkerPoolProvider>
        ) : (
          <ReadOnlySourcePreview name="big.lua" text={content} />
        ),
      );
      const { shadowRoot: shadow, container } = view;
      await userEvent.click(page.getByText(allLines[0]!, { exact: true }));
      const first = row(shadow, 1)!;
      const firstText = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!;
      // A precise initial range keeps font shaping from deciding which character a click selects.
      const selectionChanged = new Promise<void>((resolve) =>
        document.addEventListener("selectionchange", () => resolve(), { once: true }),
      );
      document.getSelection()!.setBaseAndExtent(firstText, 0, firstText, 1);
      await selectionChanged;
      container.querySelector<HTMLElement>(".file-preview-virtualizer")!.scrollTop = 390 * 20;
      await vi.waitFor(() => {
        const last = row(shadow, 400);
        if (!last) throw new Error("line 400 not rendered");
        return last;
      });
      expect(first.isConnected).toBe(false);
      row(shadow, 400)!.scrollIntoView({ block: "center", inline: "nearest" });
      await userEvent.keyboard("{Shift>}");
      await userEvent.click(page.getByText(allLines[399]!, { exact: true }));
      await userEvent.keyboard("{/Shift}");
      expect(await copy()).toBe(allLines.slice(0, 400).join("\n"));
    },
  );

  it("starts a new selection when a click follows Select All", async () => {
    await using view = await renderView(<ReadOnlySourcePreview name="big.ts" text={text} />);
    const { shadowRoot } = view;
    await userEvent.click(row(shadowRoot, 1)!);
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.click(row(shadowRoot, 4)!);
    expect(await copy()).toBeNull();
  });

  it("keeps copying the whole file from the editor in an editable view", async () => {
    await using view = await renderView(
      <DiffWorkerPoolProvider>
        <EditProvider createEditor={(type, options, key) => new Editor(type, options, key)}>
          <Virtualizer
            className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
            config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
          >
            <File
              file={{ name: "big.ts", contents: text }}
              edit
              options={{ disableFileHeader: true }}
              className="min-h-full"
            />
          </Virtualizer>
        </EditProvider>
      </DiffWorkerPoolProvider>,
    );
    const { shadowRoot } = view;
    expect(mountedRowCount(shadowRoot)).toBeLessThan(LINE_COUNT);
    await userEvent.click(row(shadowRoot, 1)!);
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(await copy()).toBe(text);
  });
});
