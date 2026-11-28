// Maths in a model's answer.
//
// FOUND FROM THE UI. Asked "what is 8/0", an agent answered with a formula,
// and the chat showed "( \frac{8}{0} )". Models write maths in LaTeX:
// \( … \) inside a sentence and \[ … \] on its own line. The chat had no maths
// support, and markdown made it worse: "\(" is markdown for a plain "(", so
// the markers were eaten and the formula's source was left on the page.
//
// The chat now renders maths with KaTeX, loaded only for an answer that has
// maths in it. remark-math reads $$ … $$: within a line it is inline maths, on
// lines of its own a block. This module finds the answers that have maths,
// turns what models write into $$ first (everywhere but in code), loads the
// two, and typesets a formula. Models write maths three ways:
//   \( … \) and \[ … \]   always maths
//   $ … $                 maths by pandoc's rule, so money stays money: the
//                         opening $ is followed by a non-space, the closing $
//                         follows a non-space and is not followed by a digit.
//                         "$E = mc^2$" is maths; "$5 to $10" and "$5-$10" are
//                         not. (remark-math's own single-$ reading has no such
//                         rule, so it stays off.)
import type { Options } from "react-markdown";

/** Whether an answer may hold maths: the markers remark-math is given. */
export function hasMath(markdown: string): boolean {
  return /\$\$|\\\(|\\\[/.test(markdown) || new RegExp(SINGLE.source).test(markdown);
}

// \( … \) and \[ … \], where the backslash is not itself escaped ("\\(" is a
// backslash and a bracket). Lazy, so two formulas on a line stay two.
const INLINE = /(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g;
const BLOCK = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;
// $ … $ on one line, by pandoc's rule (see the top): not an escaped \$, not
// part of $$, opened before a non-space, closed after a non-space and before
// anything but a digit.
const SINGLE = /(?<![\\$])\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![\d$])/g;
// A fenced code block: ``` or ~~~, up to the same fence or the end.
const FENCE = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[`~]*[ \t]*$|(?![\s\S]))/gm;

/**
 * The answer with \( … \) as $$ … $$ and \[ … \] as a $$ block, leaving fenced
 * code blocks and `inline code` exactly as they were.
 */
export function latexDelimitersToDollars(markdown: string): string {
  let out = "";
  let last = 0;
  for (const fence of markdown.matchAll(FENCE)) {
    out += outsideCode(markdown.slice(last, fence.index));
    out += fence[0];
    last = (fence.index ?? 0) + fence[0].length;
  }
  return out + outsideCode(markdown.slice(last));
}

/** Text with no fenced block in it: convert, skipping inline code spans. */
function outsideCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick === -1) break;
    // A code span opens with a run of backticks and closes with a run of the
    // same length; a run with no match is plain text.
    const run = /^`+/.exec(text.slice(tick))![0];
    const close = findRun(text, tick + run.length, run.length);
    if (close === -1) {
      out += convert(text.slice(i, tick + run.length));
      i = tick + run.length;
      continue;
    }
    out += convert(text.slice(i, tick)) + text.slice(tick, close + run.length);
    i = close + run.length;
  }
  return out + convert(text.slice(i));
}

/** Where the next run of exactly `n` backticks starts at or after `from`, or -1. */
function findRun(text: string, from: number, n: number): number {
  const re = /`+/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === n) return m.index;
  }
  return -1;
}

function convert(text: string): string {
  return text
    .replace(BLOCK, (whole, tex: string) =>
      tex.trim() === "" ? whole : `\n$$\n${tex.trim()}\n$$\n`,
    )
    .replace(INLINE, (whole, tex: string) => (tex.trim() === "" ? whole : `$$${tex.trim()}$$`))
    .replace(SINGLE, (_whole, tex: string) => `$$${tex}$$`);
}

// ── Loading and typesetting ─────────────────────────────────────────────────

/**
 * remark-math, which finds the maths. It is loaded with KaTeX and its styles
 * the first time an answer holds maths, never with the page, so the chat does
 * not carry KaTeX for answers that have none.
 */
export type MathPlugins = { remark: NonNullable<Options["remarkPlugins"]> };

type Katex = (typeof import("katex"))["default"];
let katex: Katex | null = null;
let plugins: MathPlugins | null = null;
let loading: Promise<MathPlugins> | null = null;

/** The plugins if they are loaded already, so a later answer renders at once. */
export function loadedMathPlugins(): MathPlugins | null {
  return plugins;
}

export function loadMathPlugins(): Promise<MathPlugins> {
  loading ??= Promise.all([
    import("remark-math"),
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([remarkMath, katexModule]) => {
    katex = katexModule.default;
    // A single $ is not maths: "from $5 to $10" stays money.
    plugins = { remark: [[remarkMath.default, { singleDollarTextMath: false }]] };
    return plugins;
  });
  // A failed load (offline, a missing chunk) is tried again next time.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * A formula as KaTeX's HTML, or null before KaTeX is loaded. The formula is a
 * model's text, so: trust is off (no \href, \url, \includegraphics or \html*
 * commands), a formula KaTeX cannot read comes back as its source in red
 * rather than throwing, and sizes and macro expansion are bounded so one
 * formula cannot make a page enormous or slow.
 */
export function mathToHtml(tex: string, display: boolean): string | null {
  if (!katex) return null;
  return katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    strict: "ignore",
    trust: false,
    maxSize: 20,
    maxExpand: 500,
  });
}
