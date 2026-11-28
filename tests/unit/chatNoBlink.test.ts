// Agent Chat's answers are not rebuilt while you type, nor every 4 seconds.
//
// FOUND FROM THE UI. Typing in the chat box made the screen flicker, and an
// answer with a diagram blinked every few seconds. Two faults together:
//
// - The page redrew every message far more often than any changed: on every
//   key pressed in the box (its text lives on the same component), and every
//   4 seconds, when the approvals poll stored a new object for the same answer.
// - Each redraw rebuilt every answer from scratch. MarkdownMessage made its
//   element components (paragraph, link, list, code block…) inside the render,
//   and a component made afresh is, to React, a new kind of element: the old
//   HTML was thrown away and built again. A diagram was destroyed, showed
//   "Rendering diagram…" and was drawn again by mermaid.
//
// Measured in Chrome with the real MarkdownMessage: 11 key presses redrew a
// diagram 11 times, 12 idle seconds with a 4-second poll 3 times, and text
// streaming in after a diagram 7 times in 3 seconds. With this fix, 0, 0, 0.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "@/components/playground/MarkdownMessage";

const read = (p: string) => readFileSync(p, "utf8");

describe("an answer", () => {
  const src = read("src/components/playground/MarkdownMessage.tsx");

  it("is redrawn only when its text changes", () => {
    expect((MarkdownMessage as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
    expect(src).toContain("export const MarkdownMessage = memo(MarkdownMessageView);");
  });

  it("is drawn with element components made once, never inside a render", () => {
    expect(src).toContain("components={MARKDOWN_COMPONENTS}");
    expect(src).not.toContain("components={{");
    // At the top level of the module, not in a function.
    expect(src).toMatch(/^const MARKDOWN_COMPONENTS: Components = \{$/m);
  });
});

describe("the Agent Chat page", () => {
  const page = read("src/routes/_authenticated/playground.tsx");

  it("stores the approvals poll's answer only when it changed", () => {
    expect(page).toMatch(
      /setApprovalSignals\(\(prev\) =>\s*prev\.pending === next\.pending && prev\.decided === next\.decided \? prev : next,?\s*\)/,
    );
    // Every write goes through it: a new object for the same answer redraws the page.
    expect(page.match(/setApprovalSignals\(/g)).toHaveLength(1);
  });
});

describe("a diagram", () => {
  const block = read("src/components/playground/MermaidBlock.tsx");
  const effect = block.slice(block.indexOf("useEffect(() => {"), block.indexOf("}, [code]);"));

  it("stays on screen until its replacement is drawn", () => {
    expect(effect).not.toContain("setSvg(null)");
    expect(effect).toMatch(/if \(!cancelled\) \{\s*setSvg\(rendered\);\s*setError\(null\);/);
  });
});
