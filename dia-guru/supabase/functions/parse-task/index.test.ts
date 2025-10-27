import { assertEquals, assertStringIncludes } from "std/assert";

import { __test__ } from "./index.ts";

const {
  pickDurationFromRegex,
  normalizeDucklingDuration,
  convertToMinutes,
  cleanupQuestion,
  defaultClarifyingQuestion,
  buildDeepSeekUserPrompt,
} = __test__;

Deno.test("pickDurationFromRegex handles hours and minutes", () => {
  const match = pickDurationFromRegex("Finish the report in 1h 45m");
  assertEquals(match?.minutes, 105);
});

Deno.test("pickDurationFromRegex handles shorthand minutes", () => {
  const match = pickDurationFromRegex("Need 30m to tidy up");
  assertEquals(match?.minutes, 30);
});

Deno.test("normalizeDucklingDuration converts normalized objects", () => {
  const value = normalizeDucklingDuration({
    normalized: { value: 5400, unit: "second" },
  } as Record<string, unknown>);
  assertEquals(value, 90);
});

Deno.test("convertToMinutes covers unit scaling", () => {
  assertEquals(convertToMinutes(1, "hour"), 60);
  assertEquals(convertToMinutes(90, "second"), 2);
  assertEquals(convertToMinutes(2, "day"), 2880);
});

Deno.test("cleanupQuestion flattens whitespace", () => {
  const prompt = cleanupQuestion("\nHow long will it take?\n");
  assertEquals(prompt, "How long will it take?");
});

Deno.test("defaultClarifyingQuestion prefers duration wording", () => {
  const prompt = defaultClarifyingQuestion(["estimated_minutes"]);
  assertStringIncludes(prompt.toLowerCase(), "minutes");
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
