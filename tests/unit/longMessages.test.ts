// A long setting quoted in a message cannot cover the screen.
//
// FOUND FROM THE UI. An agent whose one allowed topic was a long line refused
// every message with "Input is outside this agent's allowed topics (…)",
// quoting the topic whole: a refusal quotes up to three topics, each a line of
// a 2000-character field. The chat showed it in a toast, and a toast had no
// height limit: it grew taller than the screen, over the chat and off its top.
// Measured in Chrome, a 6,700-character error toast was 2,842px tall with its
// top 2,226px above the screen; with this change it is 114px and scrolls.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  QUOTED_TOPIC_MAX_LENGTH,
  evaluateInputGuardrails,
  parseGuardrails,
  quotedTopic,
} from "@/utils/guardrails";

const LONG = Array(200).fill("long name").join(" "); // 1,999 characters

const refusal = (settings: Record<string, string>, input = "what is 5+5") => {
  const d = evaluateInputGuardrails(input, parseGuardrails(settings));
  if (d.allowed) throw new Error("expected a refusal");
  return d.reason;
};

describe("a topic quoted in a refusal", () => {
  it("is cut to 40 characters, counted as you see them", () => {
    expect(QUOTED_TOPIC_MAX_LENGTH).toBe(40);
    // At most 40 and the "…" (a space it would end on is dropped).
    expect(Array.from(quotedTopic(LONG)).length).toBeLessThanOrEqual(41);
    expect(quotedTopic(LONG)).toBe("long name long name long name long name…");
    expect(quotedTopic(LONG).endsWith("…")).toBe(true);
    expect(Array.from(quotedTopic("🙂".repeat(60)))).toHaveLength(41);
  });

  it("is left whole when it is short", () => {
    expect(quotedTopic("customer support")).toBe("customer support");
    expect(quotedTopic("x".repeat(40))).toBe("x".repeat(40));
  });
});

describe("a refusal", () => {
  it("for allowed topics stays short, however long the topics", () => {
    const one = refusal({ allowedTopics: LONG });
    expect(one.length).toBeLessThan(120);
    const many = refusal({ allowedTopics: [LONG, LONG, LONG, LONG].join("\n") });
    expect(many.length).toBeLessThan(250);
    expect(many).toMatch(/…\)\.$/); // more than three: the list says so
  });

  it("for allowed topics reads as before when the topics are short", () => {
    expect(
      refusal({ allowedTopics: "customer support\nproduct information\ntechnical help" }),
    ).toBe(
      "Input is outside this agent's allowed topics (customer support, product information, technical help).",
    );
  });

  it("for a restricted topic stays short too", () => {
    const reason = refusal({ topicRestrictions: LONG }, LONG);
    expect(reason.length).toBeLessThan(120);
    expect(refusal({ topicRestrictions: "pricing" }, "what is your pricing")).toBe(
      `This agent isn't allowed to discuss "pricing".`,
    );
  });

  it("is checked against the whole topic, not the cut one", () => {
    // Cutting is only how a refusal quotes a topic: a message holding the
    // whole long topic is still within it.
    const d = evaluateInputGuardrails(`about ${LONG}`, parseGuardrails({ allowedTopics: LONG }));
    expect(d.allowed).toBe(true);
  });
});

describe("where a long message is shown", () => {
  it("a toast holds a few lines of title and description, and scrolls for the rest", () => {
    const sonner = readFileSync("src/components/ui/sonner.tsx", "utf8");
    expect(sonner).toContain('title: "max-h-20 overflow-y-auto wrap-anywhere",');
    expect(sonner).toMatch(/description:\s*"[^"]*max-h-32 overflow-y-auto wrap-anywhere"/);
    expect(sonner).toContain('content: "min-w-0",');
  });

  it("the Inspector's error box holds a few lines and scrolls", () => {
    const page = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");
    expect(page).toMatch(
      /<p className="max-h-48 overflow-y-auto text-xs text-destructive font-mono break-all">\s*\{exchange\.error\}/,
    );
  });
});
