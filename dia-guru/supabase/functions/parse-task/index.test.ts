import { assertEquals, assertStringIncludes } from "std/assert";

import { __test__ } from "./index.ts";

const { cleanupQuestion, buildDeepSeekUserPrompt } = __test__;

Deno.test("cleanupQuestion flattens whitespace", () => {
  const prompt = cleanupQuestion("\nHow long will it take?\n");
  assertEquals(prompt, "How long will it take?");
});

Deno.test("buildDeepSeekUserPrompt embeds structured context", () => {
  const prompt = buildDeepSeekUserPrompt({
    content: "Finish the weekly summary",
    needed: ["estimated_minutes"],
    structured: { datetime: "2025-10-26T10:00:00Z", estimated_minutes: 45 },
    timezone: "America/New_York",
  });
  assertStringIncludes(prompt, "weekly summary");
  assertStringIncludes(prompt, "Missing fields: estimated_minutes");
  assertStringIncludes(prompt, "Already parsed: estimated_minutes=45");
});

Deno.test("buildDeepSeekUserPrompt mentions ambiguous time context", () => {
  const prompt = buildDeepSeekUserPrompt({
    content: "call mom at 6",
    needed: ["time_meridiem"],
    structured: {},
    timezone: "UTC",
    context: { ambiguousTime: "6" },
  });
  const normalized = prompt.toLowerCase();
  assertStringIncludes(normalized, "ambiguous time");
  assertStringIncludes(normalized, "6");
});
