type ParseMode = "conversational_strict";

type ParseRequest = {
  text?: string;
  mode?: ParseMode;
  timezone?: string;
  now?: string;
};

type ParseResponse = {
  content: string;
  structured: {
    // Back-compat simple fields
    estimated_minutes?: number;
    datetime?: string;
    window?: { start?: string; end?: string };

    // Rich extraction payload
    extraction?: DiaGuruTaskExtraction;

    // Recommended capture fields for scheduler
    capture?: Partial<CaptureMapping> & { reason?: string };
  };
  notes: string[];
  needed: string[];
  mode: ParseMode;
  debug?: {
    deepseek_raw?: string;
    deepseek_payload_excerpt?: string;
  };
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

// Rich extraction types (aligned with test-deepseek)
type DiaGuruTaskExtraction = {
  title: string | null;
  estimated_minutes: number | null;
  deadline: { datetime: string | null; kind: "hard" | "soft" | null; source: "explicit" | "inferred" | null } | null;
  scheduled_time: { datetime: string | null; precision: "exact" | "approximate" | null; source: "explicit" | "inferred" | null } | null;
  execution_window: {
    relation:
      | "before_deadline"
      | "after_deadline"
      | "around_scheduled"
      | "between"
      | "on_day"
      | "anytime"
      | null;
    start: string | null;
    end: string | null;
    source: "explicit" | "inferred" | "default" | null;
  } | null;
  time_preferences: { time_of_day: "morning" | "afternoon" | "evening" | "night" | null; day: "today" | "tomorrow" | "specific_date" | "any" | null } | null;
  importance?: {
    urgency: 1 | 2 | 3 | 4 | 5;
    impact: 1 | 2 | 3 | 4 | 5;
    reschedule_penalty: 0 | 1 | 2 | 3;
    blocking: boolean;
    rationale: string;
  } | null;
  flexibility?: {
    cannot_overlap: boolean;
    start_flexibility: "hard" | "soft" | "anytime";
    duration_flexibility: "fixed" | "split_allowed";
    min_chunk_minutes: number | null;
    max_splits: number | null;
  } | null;
  kind?: "task" | "appointment" | "call" | "meeting" | "study" | "errand" | "other" | null;
  missing: string[];
  clarifying_question: string | null;
  notes: string[];
};

// Fields we recommend to persist onto capture_entries
type CaptureMapping = {
  estimated_minutes: number | null;
  constraint_type: "flexible" | "deadline_time" | "deadline_date" | "start_time" | "window";
  constraint_time: string | null;
  constraint_end: string | null;
  constraint_date: string | null;
  original_target_time: string | null;
  deadline_at: string | null;
  window_start: string | null;
  window_end: string | null;
  start_target_at: string | null;
  is_soft_start: boolean;
  task_type_hint: string | null;
};

const DEFAULT_TIMEZONE = "UTC";

export async function handler(req: Request) {
  try {
    const body = (await safeParseBody(req)) as ParseRequest;
    const mode: ParseMode = "conversational_strict";
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
    const referenceNow = parseReferenceNow(body.now) ?? new Date();
    const deepseekApiKey = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
    const deepseekEnabled = deepseekApiKey.length > 0;

    const notes: string[] = [];
    const heuristics: string[] = [];

    if (!deepseekEnabled) {
      const detail = "DeepSeek is required in conversational_strict mode (DEEPSEEK_API_KEY missing).";
      notes.push(detail);
      return json(
        {
          error: "DeepSeek not configured",
          details: detail,
          notes,
        },
        500,
      );
    }

    const needed: string[] = [];

    let deepseekAttempted = false;
    let deepseekLatency: number | undefined;
    let deepseekErrored = false;
    let followUp: ParseResponse["follow_up"];

    let extraction: DiaGuruTaskExtraction | null = null;
    let captureProposal: CaptureMapping | null = null;
    let lastRawMessage: string | null = null;
    let lastPayload: unknown = null;

    try {
      deepseekAttempted = true;
      const started = performance.now();
      const { systemPrompt, userPrompt } = buildExtractionPrompts({ content, timezone });

      const rawEndpoint = Deno.env.get("DEEPSEEK_API_URL");
      const endpoint = !rawEndpoint || rawEndpoint.trim() === ""
        ? "https://api.deepseek.com/v1/chat/completions"
        : /\/chat\/completions\/?$/i.test(rawEndpoint.trim())
          ? rawEndpoint.trim()
          : `${rawEndpoint.trim().replace(/\/+$/g, "")}/v1/chat/completions`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${deepseekApiKey}` },
        body: JSON.stringify({
          model: Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 600,
          temperature: 0.0,
          stream: false,
          response_format: { type: "json_object" },
        }),
      });

      const payload = await safeReadJson(res);
      lastPayload = payload;
      try { console.log("parse-task deepseek response", { status: res.status, ok: res.ok, payload }); } catch {}
      deepseekLatency = Math.round(performance.now() - started);
      if (!res.ok) {
        const snippet = typeof payload === "string" ? payload.slice(0, 200) : JSON.stringify(payload).slice(0, 200);
        throw new Error(`DeepSeek responded ${res.status}: ${snippet}`);
      }
      const message = extractDeepSeekMessage(payload);
      if (!message) throw new Error("DeepSeek returned no message content");

      const raw = String(message);
      lastRawMessage = raw;
      try { console.log("parse-task deepseek message", raw); } catch {}
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        let recovered = extractFirstJsonObject(raw);
        if (!recovered) {
          // Retry once with stricter instructions
          const strictSystem = `${systemPrompt}\nSTRICT OUTPUT: Return exactly one minified JSON object on a single line with no spaces or newlines. No markdown, no code fences, no commentary.`;
          const strictRes = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${deepseekApiKey}` },
            body: JSON.stringify({
              model: Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat",
              messages: [
                { role: "system", content: strictSystem },
                { role: "user", content: userPrompt },
              ],
              max_tokens: 1200,
              temperature: 0.0,
              top_p: 0,
              stream: false,
              response_format: { type: "json_object" },
            }),
          });
          const strictPayload = await safeReadJson(strictRes);
          if (strictRes.ok) {
            const strictMsg = extractDeepSeekMessage(strictPayload);
            if (typeof strictMsg === "string") recovered = extractFirstJsonObject(strictMsg) ?? strictMsg;
          }
        }
        if (!recovered) throw new Error("DeepSeek did not return valid JSON");
        try {
          parsed = JSON.parse(recovered);
        } catch (e2) {
          throw new Error("DeepSeek did not return valid JSON");
        }
      }
      extraction = normalizeExtraction(parsed);
      if (!extraction) throw new Error("DeepSeek JSON missing required fields");

      applyRoutineNormalization({
        extraction,
        content,
        timezone,
        referenceNow,
      });

      const mapping = mapExtractionToCapture(extraction);
      captureProposal = mapping;

      // needed list
      const missing = Array.isArray(extraction.missing) ? extraction.missing.slice() : [];
      if (extraction.estimated_minutes == null) missing.push("estimated_minutes");
      missing.sort();
      for (const m of missing) if (!needed.includes(m)) needed.push(m);

      if (missing.length > 0 && extraction.clarifying_question) {
        followUp = { type: "clarify", prompt: cleanupQuestion(extraction.clarifying_question)!, missing };
      }
      notes.push("DeepSeek extracted structured task data.");
    } catch (error) {
      deepseekErrored = true;
      const detail = describeError("DeepSeek extraction failed", error);
      notes.push(detail);
      try { console.log("parse-task deepseek extraction failed", { error: String(error), lastRawMessage, lastPayload }); } catch {}
      return json({
        error: "DeepSeek extraction failed in conversational_strict mode.",
        details: detail,
        notes,
        debug: {
          deepseek_raw: lastRawMessage ?? undefined,
          deepseek_payload_excerpt:
            typeof lastPayload === "string"
              ? (lastPayload as string).slice(0, 4000)
              : JSON.stringify(lastPayload ?? null).slice(0, 4000),
        },
      }, 502);
    }


    const response: ParseResponse = {
      content,
      structured: {
        estimated_minutes: extraction?.estimated_minutes ?? undefined,
        datetime: extraction?.scheduled_time?.datetime ?? extraction?.deadline?.datetime ?? undefined,
        window:
          extraction?.execution_window?.start || extraction?.execution_window?.end
            ? { start: extraction.execution_window?.start ?? undefined, end: extraction.execution_window?.end ?? undefined }
            : undefined,
        extraction: extraction ?? undefined,
        capture: captureProposal ? { ...captureProposal, reason: captureProposalReason(extraction!) } : undefined,
      },
      debug: {
        deepseek_raw: lastRawMessage ?? undefined,
        deepseek_payload_excerpt:
          typeof lastPayload === "string"
            ? (lastPayload as string).slice(0, 4000)
            : JSON.stringify(lastPayload ?? null).slice(0, 4000),
      },
      notes,
      needed,
      mode,
      follow_up: followUp ?? null,
      metadata: {
        duckling: {
          enabled: false,
          latency_ms: undefined,
          errored: undefined,
        },
        heuristics,
        deepseek: {
          enabled: deepseekEnabled,
          attempted: deepseekAttempted,
          latency_ms: deepseekLatency,
          errored: deepseekErrored ? true : undefined,
          used_fallback: undefined,
        },
    },
    };

    try {
      console.log("[dg.parse] summary", {
        content,
        estimated_minutes: extraction?.estimated_minutes ?? null,
        constraint_type: response.structured.capture?.constraint_type ?? null,
        constraint_time: response.structured.capture?.constraint_time ?? null,
        window_start: response.structured.capture?.window_start ?? null,
        window_end: response.structured.capture?.window_end ?? null,
        deadline_at: response.structured.capture?.deadline_at ?? null,
        start_flexibility: extraction?.flexibility?.start_flexibility ?? null,
        duration_flexibility: extraction?.flexibility?.duration_flexibility ?? null,
        cannot_overlap: extraction?.flexibility?.cannot_overlap ?? null,
        urgency: extraction?.importance?.urgency ?? null,
        impact: extraction?.importance?.impact ?? null,
        reschedule_penalty: extraction?.importance?.reschedule_penalty ?? null,
        blocking: extraction?.importance?.blocking ?? null,
        time_pref_day: extraction?.time_preferences?.day ?? null,
        time_pref_time_of_day: extraction?.time_preferences?.time_of_day ?? null,
        kind: extraction?.kind ?? null,
      });
    } catch {}

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
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return null;
    }
  }
  if (Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return null;
    }
  }
  return null;
}

function cleanupQuestion(question: string) {
  const trimmed = question.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
}

export const __test__ = {
  cleanupQuestion,
  buildDeepSeekUserPrompt,
};

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

// ----- Extraction helpers (schema + prompts) -----
function extractFirstJsonObject(text: string): string | null {
  if (!text) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fence && fence[1]) return fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1).trim();
  return null;
}
function buildExtractionPrompts(input: { content: string; timezone: string }) {
  const schema = `{
  "title": string | null,
  "estimated_minutes": number | null,
  "deadline": {
    "datetime": string | null,
    "kind": "hard" | "soft" | null,
    "source": "explicit" | "inferred" | null
  } | null,
  "scheduled_time": {
    "datetime": string | null,
    "precision": "exact" | "approximate" | null,
    "source": "explicit" | "inferred" | null
  } | null,
  "execution_window": {
    "relation": "before_deadline" | "after_deadline" | "around_scheduled" | "between" | "on_day" | "anytime" | null,
    "start": string | null,
    "end": string | null,
    "source": "explicit" | "inferred" | "default" | null
  } | null,
  "time_preferences": {
    "time_of_day": "morning" | "afternoon" | "evening" | "night" | null,
    "day": "today" | "tomorrow" | "specific_date" | "any" | null
  } | null,
  "importance": {
    "urgency": 1 | 2 | 3 | 4 | 5,
    "impact": 1 | 2 | 3 | 4 | 5,
    "reschedule_penalty": 0 | 1 | 2 | 3,
    "blocking": boolean,
    "rationale": string
  } | null,
  "flexibility": {
    "cannot_overlap": boolean,
    "start_flexibility": "hard" | "soft" | "anytime",
    "duration_flexibility": "fixed" | "split_allowed",
    "min_chunk_minutes": number | null,
    "max_splits": number | null
  } | null,
  "kind": "task" | "appointment" | "call" | "meeting" | "study" | "errand" | "other" | null,
  "missing": string[],
  "clarifying_question": string | null,
  "notes": string[]
}`;
  const rules = `Goals:\n- Interpret the user's text as a task they want to DO.\n- Distinguish clearly between DEADLINE (due/by) and SCHEDULED TIME (when to work).\n- Model how the work should be arranged in time (execution window).\n\nRules:\n- Respond ONLY with minified JSON.\n- If value is explicit or reasonably inferred, fill it; otherwise set null and add to \"missing\".\n- Infer a reasonable \"estimated_minutes\" when possible.\n- Use provided Timezone and Now for relative phrases.\n- Treat \"due/by/deadline/hand in\" as DEADLINES (set deadline.datetime/kind and execution_window.relation=before_deadline; execution_window.end=deadline).\n- \"at 3pm work on X\" → scheduled_time.datetime (+precision), execution_window.relation=around_scheduled.\n- \"between 3 and 5\" or \"tomorrow afternoon\" → execution_window.relation=between/on_day and fill start/end when resolvable.\n- time_preferences captures soft hints (morning/evening/tomorrow).\n- If anything is missing, include one concise clarifying_question.`;
  const systemPrompt = `You are a task extraction assistant for DiaGuru.\n${rules}\nSchema:\n${schema}`;
  const userPrompt = `Text: """${input.content}"""\nTimezone: ${input.timezone}\nNow: ${new Date().toISOString()}\nWorkingHours: 08:00-22:00 (local)`;
  return { systemPrompt, userPrompt };
}

function normalizeExtraction(obj: any): DiaGuruTaskExtraction | null {
  if (!obj || typeof obj !== "object") return null;
  const s = (v: any) => (typeof v === "string" ? v : null);
  const n = (v: any) => {
    const num = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(num) ? num : null;
  };
  const one = <T extends string>(v: any, vals: readonly T[]): T | null =>
    typeof v === "string" && (vals as readonly string[]).includes(v) ? (v as T) : null;

  const deadline = obj.deadline && typeof obj.deadline === "object"
    ? {
        datetime: s(obj.deadline.datetime),
        kind: one(obj.deadline.kind, ["hard", "soft"] as const),
        source: one(obj.deadline.source, ["explicit", "inferred"] as const),
      }
    : null;
  const scheduled_time = obj.scheduled_time && typeof obj.scheduled_time === "object"
    ? {
        datetime: s(obj.scheduled_time.datetime),
        precision: one(obj.scheduled_time.precision, ["exact", "approximate"] as const),
        source: one(obj.scheduled_time.source, ["explicit", "inferred"] as const),
      }
    : null;
  const execution_window = obj.execution_window && typeof obj.execution_window === "object"
    ? {
        relation: one(obj.execution_window.relation, [
          "before_deadline",
          "after_deadline",
          "around_scheduled",
          "between",
          "on_day",
          "anytime",
        ] as const),
        start: obj.execution_window.start === null ? null : s(obj.execution_window.start),
        end: obj.execution_window.end === null ? null : s(obj.execution_window.end),
        source: one(obj.execution_window.source, ["explicit", "inferred", "default"] as const),
      }
    : null;
  const time_preferences = obj.time_preferences && typeof obj.time_preferences === "object"
    ? {
        time_of_day: one(obj.time_preferences.time_of_day, ["morning", "afternoon", "evening", "night"] as const),
        day: one(obj.time_preferences.day, ["today", "tomorrow", "specific_date", "any"] as const),
      }
    : null;

  const importance = obj.importance && typeof obj.importance === "object"
    ? {
        urgency: n((obj.importance as any).urgency) as any,
        impact: n((obj.importance as any).impact) as any,
        reschedule_penalty: n((obj.importance as any).reschedule_penalty) as any,
        blocking: Boolean((obj.importance as any).blocking),
        rationale: typeof (obj.importance as any).rationale === "string" ? (obj.importance as any).rationale : "",
      }
    : null;
  const flexibility = obj.flexibility && typeof obj.flexibility === "object"
    ? {
        cannot_overlap: Boolean((obj.flexibility as any).cannot_overlap),
        start_flexibility: one((obj.flexibility as any).start_flexibility, ["hard", "soft", "anytime"] as const) ?? "soft",
        duration_flexibility: one((obj.flexibility as any).duration_flexibility, ["fixed", "split_allowed"] as const) ?? "fixed",
        min_chunk_minutes: n((obj.flexibility as any).min_chunk_minutes),
        max_splits: n((obj.flexibility as any).max_splits),
      }
    : null;

  return {
    title: s(obj.title),
    estimated_minutes: n(obj.estimated_minutes),
    deadline,
    scheduled_time,
    execution_window,
    time_preferences,
    importance,
    flexibility,
    kind: typeof obj.kind === "string" ? (obj.kind as any) : null,
    missing: Array.isArray(obj.missing) ? obj.missing.map(String) : [],
    clarifying_question: obj.clarifying_question == null ? null : String(obj.clarifying_question),
    notes: Array.isArray(obj.notes) ? obj.notes.map(String) : [],
  };
}

function mapExtractionToCapture(ex: DiaGuruTaskExtraction): CaptureMapping {
  // Defaults
  let constraint_type: CaptureMapping["constraint_type"] = "flexible";
  let constraint_time: string | null = null;
  let constraint_end: string | null = null;
  let constraint_date: string | null = null;
  let original_target_time: string | null = null;
  let deadline_at: string | null = ex.deadline?.datetime ?? null;
  let window_start: string | null = null;
  let window_end: string | null = null;
  let start_target_at: string | null = null;
  let is_soft_start = false;
  let task_type_hint: string | null = ex.kind ?? ex.title;

  // Prioritize scheduled_time if present
  if (ex.scheduled_time?.datetime) {
    constraint_type = "start_time";
    constraint_time = ex.scheduled_time.datetime;
    original_target_time = ex.scheduled_time.datetime;
    start_target_at = ex.scheduled_time.datetime;
    is_soft_start = ex.scheduled_time.precision === "approximate" || ex.scheduled_time.source === "inferred";
  }

  // Execution window explicit
  if (ex.execution_window?.relation === "between" || ex.execution_window?.relation === "on_day") {
    if (ex.execution_window.start || ex.execution_window.end) {
      constraint_type = "window";
      constraint_time = ex.execution_window.start ?? null;
      constraint_end = ex.execution_window.end ?? null;
      window_start = constraint_time;
      window_end = constraint_end;
    }
  }

  // Deadline semantics
  if (ex.execution_window?.relation === "before_deadline" && ex.deadline?.datetime) {
    constraint_type = "deadline_time";
    constraint_time = ex.deadline.datetime;
    deadline_at = ex.deadline.datetime;
    // Optionally provide a window end for schedulers that also use window
    window_end = ex.deadline.datetime;
  }

  return {
    estimated_minutes: ex.estimated_minutes ?? null,
    constraint_type,
    constraint_time,
    constraint_end,
    constraint_date,
    original_target_time,
    deadline_at,
    window_start,
    window_end,
    start_target_at,
    is_soft_start,
    task_type_hint,
  };
}

function captureProposalReason(ex: DiaGuruTaskExtraction): string {
  const bits: string[] = [];
  if (ex.deadline?.datetime) bits.push(`deadline=${ex.deadline.datetime}`);
  if (ex.scheduled_time?.datetime) bits.push(`scheduled=${ex.scheduled_time.datetime}`);
  if (ex.execution_window?.relation) bits.push(`window=${ex.execution_window.relation}`);
  if (ex.time_preferences?.time_of_day) bits.push(`pref=${ex.time_preferences.time_of_day}`);
  return `Mapped from extraction (${bits.join(", ")})`;
}

function parseReferenceNow(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function applyRoutineNormalization(args: {
  extraction: DiaGuruTaskExtraction;
  content: string;
  timezone: string;
  referenceNow: Date;
}) {
  const { extraction, content, timezone, referenceNow } = args;
  const normalizedText = content.toLowerCase();
  const mentionsSleep = /\b(sleep|nap|bed ?time)\b/i.test(content);
  const mentionsMeal = /\b(eat|meal|breakfast|lunch|dinner|snack)\b/i.test(content);

  if (mentionsSleep) {
    normalizeSleepExtraction(extraction, timezone, referenceNow);
  } else if (mentionsMeal) {
    normalizeMealExtraction(extraction, timezone, referenceNow, normalizedText);
  }

  if (/\bbefore (i )?sleep\b/i.test(content)) {
    applyBeforeSleepDeadline(extraction, timezone, referenceNow);
  }
}

function normalizeSleepExtraction(extraction: DiaGuruTaskExtraction, timezone: string, referenceNow: Date) {
  extraction.kind = "routine.sleep";
  const importance = extraction.importance ?? {
    urgency: 2,
    impact: 2,
    reschedule_penalty: 1,
    blocking: false,
    rationale: extraction.importance?.rationale ?? "Sleep routine normalized.",
  };
  importance.urgency = Math.min(importance.urgency ?? 2, 3) as 1 | 2 | 3 | 4 | 5;
  importance.impact = Math.min(importance.impact ?? 2, 3) as 1 | 2 | 3 | 4 | 5;
  importance.reschedule_penalty = Math.min(importance.reschedule_penalty ?? 1, 1) as 0 | 1 | 2 | 3;
  importance.blocking = false;
  extraction.importance = importance;

  const flexibility = extraction.flexibility ?? {
    cannot_overlap: true,
    start_flexibility: "soft",
    duration_flexibility: "fixed",
    min_chunk_minutes: extraction.estimated_minutes ?? 60,
    max_splits: 1,
  };
  flexibility.cannot_overlap = true;
  flexibility.start_flexibility = "soft";
  flexibility.duration_flexibility = "fixed";
  flexibility.min_chunk_minutes = Math.max(flexibility.min_chunk_minutes ?? 60, 30);
  flexibility.max_splits = 1;
  extraction.flexibility = flexibility;

  if (!hasExplicitWindow(extraction)) {
    const windowStart = buildZonedDateTime({
      timezone,
      reference: referenceNow,
      hour: 22,
      minute: 30,
    });
    const windowEnd = buildZonedDateTime({
      timezone,
      reference: referenceNow,
      hour: 7,
      minute: 30,
      dayOffset: 1,
    });
    extraction.execution_window = {
      relation: "between",
      start: windowStart,
      end: windowEnd,
      source: "default",
    };
  }

  if (extraction.deadline && extraction.deadline.source !== "explicit") {
    extraction.deadline = null;
  }
}

function normalizeMealExtraction(
  extraction: DiaGuruTaskExtraction,
  timezone: string,
  referenceNow: Date,
  normalizedText: string,
) {
  extraction.kind = "routine.meal";
  const importance = extraction.importance ?? {
    urgency: 2,
    impact: 2,
    reschedule_penalty: 0,
    blocking: false,
    rationale: extraction.importance?.rationale ?? "Meal routine normalized.",
  };
  importance.urgency = Math.min(importance.urgency ?? 2, 2) as 1 | 2 | 3 | 4 | 5;
  importance.impact = Math.min(importance.impact ?? 2, 2) as 1 | 2 | 3 | 4 | 5;
  importance.reschedule_penalty = 0;
  importance.blocking = false;
  extraction.importance = importance;

  const flexibility = extraction.flexibility ?? {
    cannot_overlap: false,
    start_flexibility: "soft",
    duration_flexibility: "fixed",
    min_chunk_minutes: extraction.estimated_minutes ?? 30,
    max_splits: 1,
  };
  flexibility.cannot_overlap = false;
  flexibility.start_flexibility = "soft";
  flexibility.duration_flexibility = "fixed";
  flexibility.min_chunk_minutes = Math.max(flexibility.min_chunk_minutes ?? 30, 15);
  flexibility.max_splits = 1;
  extraction.flexibility = flexibility;

  if (!hasExplicitWindow(extraction)) {
    const window = inferMealWindow(normalizedText);
    const windowStart = buildZonedDateTime({
      timezone,
      reference: referenceNow,
      hour: window.startHour,
      minute: window.startMinute,
    });
    const windowEnd = buildZonedDateTime({
      timezone,
      reference: referenceNow,
      hour: window.endHour,
      minute: window.endMinute,
    });
    extraction.execution_window = {
      relation: "between",
      start: windowStart,
      end: windowEnd,
      source: "default",
    };
  }
}

function applyBeforeSleepDeadline(extraction: DiaGuruTaskExtraction, timezone: string, referenceNow: Date) {
  const defaultDeadline = buildZonedDateTime({
    timezone,
    reference: referenceNow,
    hour: 23,
    minute: 30,
  });

  if (!extraction.deadline) {
    extraction.deadline = { datetime: defaultDeadline, kind: "soft", source: "inferred" };
  } else {
    extraction.deadline.datetime = defaultDeadline;
    extraction.deadline.kind = extraction.deadline.kind === "hard" ? "soft" : extraction.deadline.kind;
    extraction.deadline.source = extraction.deadline.source ?? "inferred";
  }

  extraction.execution_window = extraction.execution_window ?? {
    relation: "before_deadline",
    start: null,
    end: defaultDeadline,
    source: "default",
  };
  extraction.execution_window.relation = "before_deadline";
  extraction.execution_window.end = defaultDeadline;
}

function hasExplicitWindow(extraction: DiaGuruTaskExtraction) {
  return Boolean(extraction.execution_window?.start && extraction.execution_window?.end);
}

function inferMealWindow(text: string) {
  if (/\bbreakfast\b/.test(text) || /\bmorning\b/.test(text)) {
    return { startHour: 7, startMinute: 30, endHour: 9, endMinute: 30 };
  }
  if (/\blunch\b/.test(text) || /\bmidday\b/.test(text) || /\bnoon\b/.test(text)) {
    return { startHour: 12, startMinute: 0, endHour: 14, endMinute: 0 };
  }
  if (/\bdinner\b/.test(text) || /\bevening\b/.test(text)) {
    return { startHour: 18, startMinute: 0, endHour: 20, endMinute: 0 };
  }
  return { startHour: 12, startMinute: 0, endHour: 13, endMinute: 0 };
}

function buildZonedDateTime(args: {
  timezone: string;
  reference: Date;
  hour: number;
  minute: number;
  dayOffset?: number;
}) {
  const { timezone, reference, hour, minute } = args;
  const dayOffset = args.dayOffset ?? computeDayOffset(reference, timezone, hour, minute);
  const dateParts = getLocalDateParts(reference, timezone);
  const utcGuess = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + dayOffset, hour, minute, 0, 0),
  );
  const offsetMinutes = getTimezoneOffsetMinutes(utcGuess, timezone);
  return new Date(utcGuess.getTime() - offsetMinutes * 60000).toISOString();
}

function computeDayOffset(reference: Date, timezone: string, targetHour: number, targetMinute: number) {
  const { hour, minute } = getLocalTimeParts(reference, timezone);
  if (hour > targetHour) return 1;
  if (hour === targetHour && minute >= targetMinute) return 1;
  return 0;
}

function getLocalDateParts(reference: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(reference);
  const lookup = (type: "year" | "month" | "day") =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: lookup("year"),
    month: lookup("month"),
    day: lookup("day"),
  };
}

function getLocalTimeParts(reference: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [hourStr, minuteStr] = formatter.format(reference).split(":");
  return {
    hour: parseInt(hourStr, 10),
    minute: parseInt(minuteStr, 10),
  };
}

function getTimezoneOffsetMinutes(date: Date, timeZone: string) {
  const localDate = new Date(date.toLocaleString("en-US", { timeZone }));
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  return (localDate.getTime() - utcDate.getTime()) / 60000;
}
