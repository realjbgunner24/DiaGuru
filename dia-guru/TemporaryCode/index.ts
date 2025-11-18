type ParseMode = "deterministic" | "conversational" | "conversational_strict";

type ParseRequest = {
  text?: string;
  mode?: ParseMode;
  timezone?: string;
  now?: string;
};

type ParseResponse = {
  content: string;
  structured: {
    estimated_minutes?: number;
    datetime?: string;
    window?: { start?: string; end?: string };
  };
  notes: string[];
  needed: string[];
  mode: ParseMode;
  follow_up?: {
    type: "clarify";
    prompt: string;
    missing: string[];
  } | null;
  metadata: {
    duckling: {
      enabled: boolean;
      latency_ms?: number;
      errored?: boolean;
    };
    heuristics: string[];
    deepseek: {
      enabled: boolean;
      attempted: boolean;
      latency_ms?: number;
      errored?: boolean;
      used_fallback?: boolean;
    };
  };
};

type DucklingItem = {
  dim?: string;
  entity?: string;
  body?: string;
  start?: number;
  end?: number;
  value?: Record<string, unknown>;
};

type DurationCandidate = {
  minutes: number;
  source: string;
};

type TemporalCandidate =
  | { type: "value"; iso: string; source: string }
  | { type: "interval"; from?: string; to?: string; source: string };

const DEFAULT_TIMEZONE = "UTC";

export async function handler(req: Request) {
  try {
    const body = (await safeParseBody(req)) as ParseRequest;
    const mode = body.mode ?? "deterministic";
    const conversationalMode = mode === "conversational" || mode === "conversational_strict";
    const strictConversational = mode === "conversational_strict";
    const content = (body.text ?? "").trim();
    if (!content) {
      return json(
        {
          error: "text is required",
        },
        400,
      );
    }

    const timezone = (body.timezone ?? DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    const now = body.now ? new Date(body.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      return json({ error: "Invalid now timestamp" }, 400);
    }

    const rawDucklingEnabled = Boolean(Deno.env.get("DUCKLING_URL"));
    const deepseekApiKey = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
    const deepseekEnabled = deepseekApiKey.length > 0;

    const notes: string[] = [];
    const heuristics: string[] = [];

    const ducklingEnabled = rawDucklingEnabled && !strictConversational;

    let ducklingLatency: number | undefined;
    let ducklingErrored = false;
    let deepseekAttempted = false;
    let deepseekLatency: number | undefined;
    let deepseekErrored = false;
    let deepseekUsedFallback = false;
    let followUp: ParseResponse["follow_up"];
    let ducklingItems: DucklingItem[] = [];
    if (ducklingEnabled) {
      const started = performance.now();
      try {
        ducklingItems = await callDuckling(content, timezone, now);
        ducklingLatency = Math.round(performance.now() - started);
        if (ducklingItems.length === 0) {
          notes.push("Duckling returned no results.");
        }
      } catch (error) {
        ducklingErrored = true;
        notes.push(describeError("Duckling request failed", error));
      }
    } else if (strictConversational) {
      notes.push("Duckling disabled in conversational_strict mode.");
    } else {
      notes.push("Duckling disabled (DUCKLING_URL not set).");
    }

    let duration: DurationCandidate | null = null;
    let timeCandidate: TemporalCandidate | null = null;
    let ambiguousTimeSnippet: string | null = null;

    if (!strictConversational) {
      duration = pickDurationFromDuckling(ducklingItems);
      if (duration) {
        heuristics.push("duckling-duration");
      } else {
        const regexDuration = pickDurationFromRegex(content);
        if (regexDuration) {
          heuristics.push("regex-duration");
          duration = regexDuration;
        }
      }
      if (duration) {
        notes.push(`Estimated duration ${duration.minutes} minutes (source: ${duration.source}).`);
      }

      timeCandidate = pickTemporalFromDuckling(ducklingItems);
      if (timeCandidate && timeCandidate.type === "value") {
        ambiguousTimeSnippet = detectAmbiguousMeridiemSnippet(
          timeCandidate.source ?? "",
          content,
        );
        if (ambiguousTimeSnippet) {
          notes.push(`Time "${ambiguousTimeSnippet}" is missing an AM/PM indicator.`);
        }
      }
      if (timeCandidate) {
        heuristics.push("duckling-time");
        if (timeCandidate.type === "value" && timeCandidate.iso) {
          notes.push(`Detected time constraint (${timeCandidate.iso}) from "${timeCandidate.source}".`);
        } else if (timeCandidate.type === "interval") {
          const windows: string[] = [];
          if (timeCandidate.from) windows.push(`from ${timeCandidate.from}`);
          if (timeCandidate.to) windows.push(`to ${timeCandidate.to}`);
          notes.push(`Detected interval ${windows.join(" ")} from "${timeCandidate.source}".`.trim());
        }
      }
    }

    const structured: ParseResponse["structured"] = {};
    if (!strictConversational && duration) {
      structured.estimated_minutes = duration.minutes;
    }
    if (!strictConversational && timeCandidate) {
      if (timeCandidate.type === "value" && timeCandidate.iso) {
        if (!ambiguousTimeSnippet) {
          structured.datetime = timeCandidate.iso;
        }
      } else if (timeCandidate.type === "interval") {
        const { from, to } = timeCandidate;
        if (from && to) {
          structured.window = { start: from, end: to };
        } else if (from || to) {
          structured.datetime = from ?? to;
        }
      }
    }

    const needed: string[] = [];
    if (!structured.estimated_minutes) {
      needed.push("estimated_minutes");
    }
    if (ambiguousTimeSnippet && !needed.includes("time_meridiem")) {
      needed.push("time_meridiem");
    }

    if (conversationalMode) {
      const clarifyingContext = { ambiguousTime: ambiguousTimeSnippet ?? undefined };
      if (deepseekEnabled) {
        deepseekAttempted = true;
        const started = performance.now();
        try {
          const question = await requestDeepSeekClarification({
            apiKey: deepseekApiKey,
            content,
            needed,
            structured,
            timezone,
            context: clarifyingContext,
          });
          deepseekLatency = Math.round(performance.now() - started);
          if (question) {
            followUp = { type: "clarify", prompt: question, missing: [...needed] };
            notes.push("DeepSeek generated a clarifying question.");
          } else {
            deepseekUsedFallback = true;
            notes.push("DeepSeek returned empty response; using deterministic prompt.");
          }
        } catch (error) {
          deepseekErrored = true;
          deepseekUsedFallback = true;
          const detail = describeError("DeepSeek request failed", error);
          notes.push(detail);
          if (strictConversational) {
            return json(
              {
                error: "DeepSeek request failed in conversational_strict mode.",
                details: detail,
                notes,
              },
              502,
            );
          }
        }
      } else {
        deepseekUsedFallback = true;
        const detail = "DeepSeek disabled (DEEPSEEK_API_KEY not set); using deterministic prompt.";
        notes.push(detail);
        if (strictConversational) {
          return json(
            {
              error: "DeepSeek is required in conversational_strict mode (DEEPSEEK_API_KEY missing).",
              details: detail,
              notes,
            },
            400,
          );
        }
      }

      if (!followUp) {
        if (strictConversational) {
          return json(
            {
              error: "DeepSeek did not provide a clarifying question in conversational_strict mode.",
              details: "DeepSeek returned empty content or no choices.",
              notes,
            },
            502,
          );
        }

        const prompt = defaultClarifyingQuestion(needed, clarifyingContext);
        followUp = { type: "clarify", prompt, missing: [...needed] };
        notes.push("Using deterministic fallback clarifying question.");
      }
    }


    const response: ParseResponse = {
      content,
      structured,
      notes,
      needed,
      mode,
      follow_up: followUp ?? null,
      metadata: {
        duckling: {
          enabled: ducklingEnabled,
          latency_ms: ducklingLatency,
          errored: ducklingErrored || undefined,
        },
        heuristics,
        deepseek: {
          enabled: deepseekEnabled,
          attempted: deepseekAttempted,
          latency_ms: deepseekLatency,
          errored: deepseekErrored ? true : undefined,
          used_fallback: deepseekUsedFallback ? true : undefined,
        },
      },
    };

    return json(response);
  } catch (error) {
    console.error("parse-task error", error);
    return json({ error: "Internal server error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function safeParseBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function callDuckling(text: string, timezone: string, now: Date) {
  const base = Deno.env.get("DUCKLING_URL");
  if (!base) return [];

  const endpoint = base.endsWith("/") ? `${base}parse` : `${base}/parse`;
  const params = new URLSearchParams();
  params.set("text", text);
  params.set("locale", "en_US");
  params.set("tz", timezone);
  params.set("reftime", String(now.getTime()));

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Duckling responded ${res.status}: ${body.slice(0, 200)}`);
  }

  const payload = await res.json();
  if (!Array.isArray(payload)) return [];
  return payload as DucklingItem[];
}

function pickDurationFromDuckling(items: DucklingItem[]): DurationCandidate | null {
  for (const item of items) {
    const dim = item.dim ?? item.entity;
    if (dim !== "duration") continue;
    const candidate = normalizeDucklingDuration(item.value ?? {});
    if (candidate) {
      return { minutes: candidate, source: item.body ?? "duckling" };
    }
  }
  return null;
}

function normalizeDucklingDuration(value: Record<string, unknown>) {
  const directValue = readNumber(value, "value");
  const seconds = readNumber(value, "seconds");
  const directUnit = readString(value, "unit");

  if (directValue !== null && directUnit) {
    return convertToMinutes(directValue, directUnit);
  }

  if (seconds !== null) {
    return convertToMinutes(seconds, "second");
  }

  const normalized = value["normalized"];
  if (normalized && typeof normalized === "object") {
    const val = readNumber(normalized as Record<string, unknown>, "value");
    const unit = readString(normalized as Record<string, unknown>, "unit");
    if (val !== null && unit) {
      return convertToMinutes(val, unit);
    }
  }

  const from = value["from"];
  if (from && typeof from === "object") {
    const val = readNumber(from as Record<string, unknown>, "value");
    const unit = readString(from as Record<string, unknown>, "unit");
    if (val !== null && unit) {
      return convertToMinutes(val, unit);
    }
  }

  const to = value["to"];
  if (to && typeof to === "object") {
    const val = readNumber(to as Record<string, unknown>, "value");
    const unit = readString(to as Record<string, unknown>, "unit");
    if (val !== null && unit) {
      return convertToMinutes(val, unit);
    }
  }

  return null;
}

function pickTemporalFromDuckling(items: DucklingItem[]): TemporalCandidate | null {
  for (const item of items) {
    const dim = item.dim ?? item.entity;
    if (dim !== "time") continue;
    const value = item.value ?? {};
    const type = readString(value, "type");
    if (type === "value") {
      const iso = readString(value, "value");
      if (iso) {
        return { type: "value", iso, source: item.body ?? "duckling" };
      }
    }
    if (type === "interval") {
      const from = readNestedString(value, ["from", "value"]);
      const to = readNestedString(value, ["to", "value"]);
      if (from || to) {
        return { type: "interval", from: from ?? undefined, to: to ?? undefined, source: item.body ?? "duckling" };
      }
    }
  }
  return null;
}

function pickDurationFromRegex(text: string): DurationCandidate | null {
  const normalized = text.toLowerCase();
  const compactMatch = /(\d+)\s*h(?:\s*(\d+)\s*m)?/.exec(normalized);
  if (compactMatch) {
    const hours = Number(compactMatch[1]);
    const minutes = compactMatch[2] ? Number(compactMatch[2]) : 0;
    const total = hours * 60 + minutes;
    if (!Number.isNaN(total) && total > 0) {
      return { minutes: total, source: compactMatch[0] };
    }
  }

  const fractional = /(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?/.exec(normalized);
  if (fractional) {
    const hours = Number(fractional[1]);
    if (!Number.isNaN(hours) && hours > 0) {
      return { minutes: Math.round(hours * 60), source: fractional[0] };
    }
  }

  const minutesMatch = /(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/.exec(normalized);
  if (minutesMatch) {
    const minutes = Number(minutesMatch[1]);
    if (!Number.isNaN(minutes) && minutes > 0) {
      return { minutes: Math.round(minutes), source: minutesMatch[0] };
    }
  }

  return null;
}

function convertToMinutes(value: number, unit: string) {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("second")) {
    return Math.max(1, Math.round(value / 60));
  }
  if (normalized.startsWith("minute")) {
    return Math.max(1, Math.round(value));
  }
  if (normalized.startsWith("hour") || normalized === "h") {
    return Math.max(1, Math.round(value * 60));
  }
  if (normalized.startsWith("day")) {
    return Math.max(1, Math.round(value * 24 * 60));
  }
  return null;
}

function readNumber(obj: Record<string, unknown>, key: string) {
  const direct = obj[key];
  if (typeof direct === "number") return direct;
  if (typeof direct === "string") {
    const parsed = Number(direct);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function readString(obj: Record<string, unknown>, key: string) {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function readNestedString(obj: Record<string, unknown>, path: string[]) {
  let current: unknown = obj;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : null;
}

async function requestDeepSeekClarification(input: {
  apiKey: string;
  content: string;
  needed: string[];
  structured: ParseResponse["structured"];
  timezone: string;
  context?: { ambiguousTime?: string };
}) {
  if (!input.apiKey) return null;
  const rawEndpoint = Deno.env.get("DEEPSEEK_API_URL");
  let endpoint: string;
  if (rawEndpoint && rawEndpoint.trim().length > 0) {
    const trimmed = rawEndpoint.trim().replace(/\s+/g, "");
    if (/\/chat\/completions\/?$/i.test(trimmed)) {
      endpoint = trimmed;
    } else {
      const base = trimmed.replace(/\/+$/g, "");
      endpoint = `${base}/v1/chat/completions`;
    }
  } else {
    endpoint = "https://api.deepseek.com/v1/chat/completions";
  }
  const systemPrompt =
    "You help DiaGuru collect missing task details. Ask exactly one concise follow-up question to obtain the missing information. Never answer the question yourself.";
  const userPrompt = buildDeepSeekUserPrompt({
    content: input.content,
    needed: input.needed,
    structured: input.structured,
    timezone: input.timezone,
    context: input.context,
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 120,
      temperature: 0.2,
      stream: false,
    }),
  });

  const payload = await safeReadJson(res);
  if (!res.ok) {
    const snippet = typeof payload === "string" ? payload.slice(0, 200) : JSON.stringify(payload).slice(0, 200);
    throw new Error(`DeepSeek responded ${res.status}: ${snippet}`);
  }

  const message = extractDeepSeekMessage(payload);
  if (!message) return null;
  return cleanupQuestion(message);
}

function buildDeepSeekUserPrompt(input: {
  content: string;
  needed: string[];
  structured: ParseResponse["structured"];
  timezone: string;
  context?: { ambiguousTime?: string };
}) {
  const parts = [
    `Capture text: """${input.content}"""`,
    `Missing fields: ${input.needed.join(", ")}`,
    `Timezone: ${input.timezone}`,
  ];
  const structuredBits: string[] = [];
  if (input.structured.estimated_minutes) {
    structuredBits.push(`estimated_minutes=${input.structured.estimated_minutes}`);
  }
  if (input.structured.datetime) {
    structuredBits.push(`datetime=${input.structured.datetime}`);
  }
  if (input.structured.window) {
    structuredBits.push(`window=${input.structured.window.start} -> ${input.structured.window.end}`);
  }
  if (structuredBits.length > 0) {
    parts.push(`Already parsed: ${structuredBits.join(", ")}`);
  }
  if (input.context?.ambiguousTime) {
    parts.push(`Ambiguous time detected: ${input.context.ambiguousTime} (needs AM/PM clarification).`);
  }
  parts.push(
    "Ask a single short clarifying question to collect the missing field(s). Do not propose values; only ask for the information.",
  );
  return parts.join("\n");
}

async function safeReadJson(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractDeepSeekMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const normalized = payload as Record<string, unknown>;
  const choices = normalized.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

function cleanupQuestion(question: string) {
  const trimmed = question.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
}

function defaultClarifyingQuestion(
  missing: string[],
  context?: { ambiguousTime?: string },
) {
  if (missing.includes("time_meridiem") && context?.ambiguousTime) {
    return `Did you mean ${context.ambiguousTime}am or ${context.ambiguousTime}pm?`;
  }
  if (missing.includes("estimated_minutes")) {
    return "Please enter an estimated number of minutes so DiaGuru can schedule this.";
  }
  return `Could you share the following details: ${missing.join(", ")}?`;
}

export const __test__ = {
  pickDurationFromRegex,
  normalizeDucklingDuration,
  convertToMinutes,
  cleanupQuestion,
  defaultClarifyingQuestion,
  buildDeepSeekUserPrompt,
  detectAmbiguousMeridiemSnippet,
};

function detectAmbiguousMeridiemSnippet(source: string, fallbackText: string) {
  const snippet = findAmbiguousTimeToken(source);
  if (snippet) return snippet;
  if (!source.trim()) {
    return findAmbiguousTimeToken(fallbackText);
  }
  return null;
}

function findAmbiguousTimeToken(text: string) {
  const durationRegex = /\b(hours?|hrs?|minutes?|mins?)\b/i;
  if (durationRegex.test(text)) return null;
  const meridiemRegex = /\b(a\.?m\.?|p\.?m\.?|am|pm)\b/i;
  if (meridiemRegex.test(text)) return null;
  const match = /\b(0?[1-9]|1[0-2])(:[0-5]\d)?\b/.exec(text);
  if (!match) return null;
  return match[0].replace(/^0/, "");
}

function describeError(prefix: string, error: unknown) {
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${String(error)}`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
