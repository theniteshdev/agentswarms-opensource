// Maths in a model's answer is typeset, not shown as its LaTeX source.
//
// FOUND FROM THE UI. Asked "what is 8/0", an agent answered with a formula and
// the chat showed "( \frac{8}{0} )". Models write maths in LaTeX, \( … \) in a
// sentence and \[ … \] on its own line; the chat had no maths support, and
// markdown ate the markers ("\(" is markdown for a plain "("), leaving the
// formula's source on the page.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { hasMath, latexDelimitersToDollars, loadMathPlugins } from "@/lib/markdownMath";

// The answer as the model sent it (from the Inspector).
const ANSWER =
  "Division by zero is **undefined** — there is no real number result for \\( \\frac{8}{0} \\). " +
  "It leads to a mathematical error or infinity (in extended systems), but it doesn't have a finite value." +
  "\n\nSo:\n\\[\n\\frac{8}{0} \\text{ is undefined.}\n\\]";

const html = (content: string) => renderToStaticMarkup(createElement(MarkdownMessage, { content }));
/** What a reader sees: the HTML's text, without KaTeX's copy for screen readers. */
const seen = (h: string) =>
  h
    .replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("finding maths", () => {
  it("is \\( \\), \\[ \\], $$, or $ … $ that is not money", () => {
    expect(hasMath(ANSWER)).toBe(true);
    expect(hasMath("$$x^2$$")).toBe(true);
    expect(hasMath("Inline: $E = mc^2$")).toBe(true);
    for (const money of ["It costs $5 to $10.", "between $5-$10", "I have $5, you have $3"]) {
      expect(hasMath(money), money).toBe(false);
    }
    expect(hasMath("Plain text (with brackets) [and more].")).toBe(false);
  });
});

describe("the markers models write", () => {
  it("\\( … \\) becomes inline $$ … $$, \\[ … \\] a $$ block", () => {
    expect(latexDelimitersToDollars("is \\( \\frac{8}{0} \\).")).toBe("is $$\\frac{8}{0}$$.");
    expect(latexDelimitersToDollars("So:\n\\[\n\\frac{8}{0}\n\\]")).toBe(
      "So:\n\n$$\n\\frac{8}{0}\n$$\n",
    );
  });

  // FOUND FROM THE UI, testing the first version: asked for a test of the
  // maths, a model wrote its inline formulas as $ … $, and they stayed text.
  it("$ … $ becomes $$ … $$ by pandoc's rule, and money is left alone", () => {
    expect(latexDelimitersToDollars("Inline: $E = mc^2$ and $\\frac{a}{b} + \\sqrt{x}$")).toBe(
      "Inline: $$E = mc^2$$ and $$\\frac{a}{b} + \\sqrt{x}$$",
    );
    expect(latexDelimitersToDollars("$5.00 and the variable $x$")).toBe(
      "$5.00 and the variable $$x$$",
    );
    for (const text of [
      "It costs $5 to $10.", // the closing $ follows a space
      "between $5-$10", // the closing $ is followed by a digit
      "I have $5, you have $3",
      "a $ b $ c", // the opening $ is followed by a space
      "Price \\$5 and \\$6", // escaped
      "$$x^2$$", // already maths
    ]) {
      expect(latexDelimitersToDollars(text), text).toBe(text);
    }
  });

  it("keeps two formulas on a line apart, and brackets inside one", () => {
    expect(latexDelimitersToDollars("\\(a\\) and \\(f(x)\\)")).toBe("$$a$$ and $$f(x)$$");
  });

  it("is left alone in code, in an escaped bracket, and when empty", () => {
    for (const text of [
      "`\\(x\\)` in code",
      "```\n\\(x\\)\n```",
      "~~~\n\\[x\\]\n~~~",
      "```\nnever closed \\(x\\)",
      "a \\\\( b \\\\)",
      "\\(\\) and \\[ \\]",
    ]) {
      expect(latexDelimitersToDollars(text), text).toBe(text);
    }
  });
});

describe("before KaTeX has loaded", () => {
  it("an answer is drawn as text, as it always was", () => {
    expect(html("a \\(x\\) b")).not.toContain('class="katex"');
  });
});

describe("once KaTeX has loaded", () => {
  beforeAll(async () => {
    await loadMathPlugins();
  });

  it("the reported answer is typeset, with no LaTeX left to read", () => {
    const h = html(ANSWER);
    expect(h.match(/class="katex"/g)).toHaveLength(2); // inline, and the block
    expect(h).toContain("katex-display");
    expect(seen(h)).not.toMatch(/\\frac|\\text|\( *8/);
  });

  it("money stays money", () => {
    expect(seen(html("It costs $5 to $10."))).toBe("It costs $5 to $10.");
    expect(seen(html("Price \\$5 and \\(x\\)"))).toBe("Price $5 and x");
    // In an answer that has maths too, where the maths plugin reads it.
    const h = html("It costs $5 to $10, and \\(x^2\\) grows.");
    expect(h.match(/class="katex"/g)).toHaveLength(1);
    expect(seen(h)).toMatch(/^It costs \$5 to \$10, and .* grows\.$/);
  });

  it("$ … $ in an answer is typeset, beside money that is not", () => {
    const h = html("Inline: $E = mc^2$ and $\\frac{a}{b}$. It costs $5 to $10.");
    expect(h.match(/class="katex"/g)).toHaveLength(2);
    expect(seen(h)).toMatch(/It costs \$5 to \$10\.$/);
    expect(seen(h)).not.toContain("\\frac");
  });

  it("code stays code", () => {
    expect(html("`\\(x\\)` in code")).not.toContain('class="katex"');
    expect(html("```\n\\(x\\)\n```")).not.toContain('class="katex"');
  });

  it("a ```math fence is a maths block, as on GitHub", () => {
    expect(html("```math\na^2+b^2=c^2\n```")).toContain("katex-display");
  });

  it("a formula KaTeX cannot read shows its source, and does not break the answer", () => {
    const h = html("before \\( \\frac{1}{ \\) after");
    expect(h).toContain("katex-error");
    expect(seen(h)).toMatch(/^before .* after$/);
  });

  it("a formula cannot add links, pictures or HTML (trust is off)", () => {
    for (const tex of [
      "\\(\\href{javascript:alert(1)}{x}\\)",
      "\\(\\url{javascript:alert(1)}\\)",
      "\\(\\includegraphics{https://example.com/a.png}\\)",
      "\\(\\htmlData{x=1}{y}\\)",
      "\\(<img src=x onerror=alert(1)>\\)",
    ]) {
      const h = html(tex);
      expect(h, tex).not.toMatch(/<a\b|<img\b|href="javascript|<[^>]* on\w+=|data-x=/i);
    }
  });
});

describe("the page", () => {
  it("loads KaTeX only for an answer with maths, never with the chat", () => {
    const chat = readFileSync("src/components/playground/MarkdownMessage.tsx", "utf8");
    const lib = readFileSync("src/lib/markdownMath.ts", "utf8");
    for (const src of [chat, lib]) {
      expect(src).not.toMatch(/^import [^;]*from "(katex|remark-math)"/m);
    }
    expect(lib).toContain('import("remark-math")');
    expect(lib).toContain('import("katex")');
    expect(lib).toContain('import("katex/dist/katex.min.css")');
  });

  it("asks for the KaTeX version the project already pins", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies.katex).toBe(pkg.overrides.katex);
    expect(pkg.dependencies["remark-math"]).toBeTruthy();
  });
});
