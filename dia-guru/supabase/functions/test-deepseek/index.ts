type TestMode = "clarify" | "extract";

type TestRequest = {
  // General
  mode?: TestMode;
  model?: string;
  system?: string;

  // Clarify mode inputs
  content?: string; // user capture text
  needed?: string[]; // which fields are missing
  timezone?: string; // e.g., "UTC" or "America/New_York"
  structured?: {
    estimated_minutes?: number;
    datetime?: string;
    window?: { start?: string; end?: string };
  };

  // Legacy/generic prompt (fallback/simple test)
  prompt?: string;
};

type ClarifyResponse = {
  mode: "clarify";
  prompt_sent: string;
  clarifying_question: string;
  model: string;
  latency_ms: number;
};

// Extended extraction facets
type DeadlineKind = "hard" | "soft";
type SourceKind = "explicit" | "inferred";
type ExecutionRelation =
  | "before_deadline"
  | "after_deadline"
  | "around_scheduled"
  | "between"
  | "on_day"
  | "anytime";
type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
type DayPref = "today" | "tomorrow" | "specific_date" | "any";
type StartFlex = "hard" | "soft" | "anytime";
type DurationFlex = "fixed" | "split_allowed";
type ExtractionKind =
  | "task"
  | "appointment"
  | "call"
  | "meeting"
  | "study"
  | "errand"
  | "other";
type Importance = {
  urgency: 1 | 2 | 3 | 4 | 5;
  impact: 1 | 2 | 3 | 4 | 5;
  reschedule_penalty: 0 | 1 | 2 | 3;
  blocking: boolean;
  rationale: string;
} | null;
type Flexibility = {
  cannot_overlap: boolean;
  start_flexibility: StartFlex;
  duration_flexibility: DurationFlex;
  min_chunk_minutes: number | null;
  max_splits: number | null;
} | null;

type DiaGuruTaskExtraction = {
  title: string | null;
  estimated_minutes: number | null;
  deadline: {
    datetime: string | null;
    kind: DeadlineKind | null;
    source: SourceKind | null;
  } | null;
  scheduled_time: {
    datetime: string | null;
    precision: "exact" | "approximate" | null;
    source: SourceKind | null;
  } | null;
  execution_window: {
    relation: ExecutionRelation | null;
    start: string | null;
    end: string | null;
    source: SourceKind | "default" | null;
  } | null;
  time_preferences: {
    time_of_day: TimeOfDay | null;
    day: DayPref | null;
  } | null;
  importance: Importance;
  flexibility: Flexibility;
  kind: ExtractionKind | null;
  missing: string[];
  clarifying_question: string | null;
  notes: string[];
};

type ExtractResponse = {
  mode: "extract";
  input: { content: string; timezone: string };
  parsed: DiaGuruTaskExtraction;
  raw_text: string; // exact message.content before JSON.parse
  model: string;
  latency_ms: number;
};

type SimpleResponse = {
  mode: "simple";
  prompt: string;
  reply: string;
  model: string;
  latency_ms: number;
};

export async function handler(req: Request) {
  try {
    const body = (await safeParseBody(req)) as TestRequest;
    const apiKey = (Deno.env.get("DEEPSEEK_API_KEY") ?? "").trim();
    const model = (body.model ?? Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat").trim();
    const mode: TestMode = (body.mode as TestMode) || "clarify";

    if (!apiKey) {
      return json({ error: "DEEPSEEK_API_KEY not configured on the server" }, 500);
    }

    const endpoint = resolveDeepSeekEndpoint();

    if (mode === "clarify") {
      const content = (body.content ?? "").trim();
      const timezone = (body.timezone ?? "UTC").trim() || "UTC";
      const needed = Array.isArray(body.needed) && body.needed.length > 0 ? body.needed : ["estimated_minutes", "datetime"];
      const structured = body.structured ?? {};
      if (!content) return json({ error: "content is required for clarify mode" }, 400);

      const systemPrompt =
        "You help DiaGuru collect missing task details. Ask exactly one concise follow-up question to obtain the missing information. Never answer the question yourself.";
      const userPrompt = buildDeepSeekUserPrompt({ content, needed, structured, timezone });

      const started = performance.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: body.system ? String(body.system) : systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 120,
          temperature: 0.2,
          stream: false,
        }),
      });
      const payload = await safeReadJson(res);
      try { console.log("test-deepseek payload", { status: res.status, ok: res.ok, payload }); } catch {}
      if (!res.ok) {
        const snippet = typeof payload === "string" ? payload.slice(0, 200) : JSON.stringify(payload).slice(0, 200);
        return json({ error: `DeepSeek responded ${res.status}: ${snippet}` }, 502);
      }
      const message = extractDeepSeekMessage(payload);
      if (!message) return json({ error: "DeepSeek returned an unexpected response (no message)." }, 502);
      const latency = Math.round(performance.now() - started);
      const out: ClarifyResponse = {
        mode: "clarify",
        prompt_sent: userPrompt,
        clarifying_question: cleanupText(message),
        model,
        latency_ms: latency,
      };
      return json(out);
    }

    if (mode === "extract") {
      const content = (body.content ?? "").trim();
      const timezone = (body.timezone ?? "UTC").trim() || "UTC";
      if (!content) return json({ error: "content is required for extract mode" }, 400);

      const { systemPrompt, userPrompt } = buildExtractionPrompts({ content, timezone });

      const started = performance.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: body.system ? String(body.system) : systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 600,
          temperature: 0.0,
          stream: false,
          response_format: { type: "json_object" },
        }),
      });
      const payload = await safeReadJson(res);
      if (!res.ok) {
        const snippet = typeof payload === "string" ? payload.slice(0, 200) : JSON.stringify(payload).slice(0, 200);
        return json({ error: `DeepSeek responded ${res.status}: ${snippet}` }, 502);
      }
      const message = extractDeepSeekMessage(payload);
      if (!message) return json({ error: "DeepSeek returned an unexpected response (no message)." }, 502);

      const rawText = String(message);
      try { console.log("test-deepseek raw_text", rawText); } catch {}
      let parsed: ExtractResponse["parsed"] | null = null;
      let obj: any = null;
      try {
        obj = JSON.parse(rawText);
      } catch (_) {
        const recovered = extractFirstJsonObject(rawText);
        if (recovered) {
          try {
            obj = JSON.parse(recovered);
          } catch (_) {
            // continue to error
          }
        }
      }
      if (!obj) {
        // Retry once with stricter instructions
        const { systemPrompt, userPrompt } = buildExtractionPrompts({ content, timezone });
        const strictSystem = `${systemPrompt}\nSTRICT OUTPUT: Return exactly one minified JSON object. No markdown, no code fences, no commentary.`;
        try {
          const strict = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: strictSystem },
                { role: "user", content: userPrompt },
              ],
              max_tokens: 300,
              temperature: 0.0,
              top_p: 0,
              stream: false,
              response_format: { type: "json_object" },
            }),
          });
          const strictPayload = await safeReadJson(strict);
          if (strict.ok) {
            const strictMsg = extractDeepSeekMessage(strictPayload);
            if (typeof strictMsg === "string") {
              const strictRaw = extractFirstJsonObject(strictMsg) ?? strictMsg;
              try {
                obj = JSON.parse(strictRaw);
              } catch {}
            }
          }
        } catch {}
      }
      if (!obj) return json({ error: "DeepSeek did not return valid JSON", raw_text: rawText }, 502);
      parsed = normalizeExtraction(obj);
      if (!parsed) return json({ error: "DeepSeek JSON missing required fields", raw_text: rawText }, 502);

      const latency = Math.round(performance.now() - started);
      const out: ExtractResponse = {
        mode: "extract",
        input: { content, timezone },
        parsed,
        raw_text: rawText,
        model,
        latency_ms: latency,
      };
      return json(out);
    }

    // Fallback simple mode for generic prompt testing
    const prompt = (body.prompt ?? "Say hello from DeepSeek.").trim();
    const started = performance.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: (body.system ?? "You are a helpful assistant.").trim() },
          { role: "user", content: prompt },
        ],
        max_tokens: 256,
        temperature: 0.2,
        stream: false,
      }),
    });
    const payload = await safeReadJson(res);
    if (!res.ok) {
      const snippet = typeof payload === "string" ? payload.slice(0, 200) : JSON.stringify(payload).slice(0, 200);
      return json({ error: `DeepSeek responded ${res.status}: ${snippet}` }, 502);
    }
    const message = extractDeepSeekMessage(payload);
    if (!message) return json({ error: "DeepSeek returned an unexpected response (no message)." }, 502);
    const latency = Math.round(performance.now() - started);
    const out: SimpleResponse = {
      mode: "simple",
      prompt,
      reply: cleanupText(message),
      model,
      latency_ms: latency,
    };
    return json(out);
  } catch (error) {
    console.error("test-deepseek error", error);
    return json({ error: "Internal server error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

function resolveDeepSeekEndpoint() {
  const raw = Deno.env.get("DEEPSEEK_API_URL");
  if (raw && raw.trim().length > 0) {
    const trimmed = raw.trim().replace(/\s+/g, "");
    if (/\/chat\/completions\/?$/i.test(trimmed)) return trimmed;
    const base = trimmed.replace(/\/+$/g, "");
    return `${base}/v1/chat/completions`;
  }
  return "https://api.deepseek.com/v1/chat/completions";
}

async function safeParseBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
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

function cleanupText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Attempt to pull a JSON object out of messy model output
function extractFirstJsonObject(text: string): string | null {
  if (!text) return null;
  // Strip code fences if present
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fence && fence[1]) return fence[1].trim();
  // Fallback: find first '{' and last '}' and hope it's JSON
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
}

// Utilities specific to clarify mode (mirrors parse-task build helper)
function buildDeepSeekUserPrompt(input: {
  content: string;
  needed: string[];
  structured: { estimated_minutes?: number; datetime?: string; window?: { start?: string; end?: string } };
  timezone: string;
  context?: { ambiguousTime?: string };
}) {
  const parts = [
    `Capture text: """${input.content}"""`,
    `Missing fields: ${input.needed.join(", ")}`,
    `Timezone: ${input.timezone}`,
  ];
  const structuredBits: string[] = [];
  if (input.structured.estimated_minutes) structuredBits.push(`estimated_minutes=${input.structured.estimated_minutes}`);
  if (input.structured.datetime) structuredBits.push(`datetime=${input.structured.datetime}`);
  if (input.structured.window)
    structuredBits.push(`window=${input.structured.window.start} -> ${input.structured.window.end}`);
  if (structuredBits.length > 0) parts.push(`Already parsed: ${structuredBits.join(", ")}`);
  if (input.context?.ambiguousTime) parts.push(`Ambiguous time detected: ${input.context.ambiguousTime}.`);
  parts.push(
    "Ask a single short clarifying question to collect the missing field(s). Do not propose values; only ask for the information.",
  );
  return parts.join("\n");
}

// Utilities for extraction mode
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

  const rules = `Goals:\n- Interpret the user's text as a task they want to DO.\n- Distinguish clearly between a DEADLINE (when something is due) and a SCHEDULED TIME (when to work).\n- Model how the work should be arranged in time (execution window).\n\nRules:\n- Always output a single JSON object.\n- Respond ONLY with minified JSON. No markdown, code fences, or commentary.\n- If a value is explicitly given or can be reasonably inferred, fill it and DO NOT list it in \"missing\".\n- If a value cannot be reasonably inferred, set it to null and add its key to \"missing\".\n- For \"estimated_minutes\", infer a reasonable value when possible.\n- Use provided Timezone and Now for relative phrases (today/tomorrow/afternoon).\n- Treat words like \"due\", \"by\", \"deadline\", \"hand in\" as DEADLINES:\n  * set deadline.datetime, deadline.kind (hard unless flexible),\n  * set execution_window.relation=before_deadline and execution_window.end=deadline.datetime.\n- Phrases like \"at 3pm work on X\" or \"tomorrow at 9\" describe WHEN TO WORK:\n  * set scheduled_time.datetime and precision,\n  * set execution_window.relation=around_scheduled (set start/end if useful).\n- Phrases like \"between 3 and 5\", \"tomorrow afternoon\", \"sometime on Friday\":\n  * set execution_window.relation=between or on_day as appropriate,\n  * fill start/end when resolvable.\n- time_preferences captures soft hints like \"morning\" or \"tomorrow\" even if no precise time.\n- If anything is missing, include one concise \"clarifying_question\" that targets the most important gap.\n- JSON must be valid and minified; no extra keys, comments, or trailing commas.`;

  const systemPrompt = `You are a task extraction assistant for DiaGuru.\n${rules}\nSchema:\n${schema}`;

  const userPrompt = `Text: """${input.content}"""\nTimezone: ${input.timezone}\nNow: ${new Date().toISOString()}`;
  return { systemPrompt, userPrompt };
}

function normalizeExtraction(obj: any): ExtractResponse["parsed"] | null {
  if (!obj || typeof obj !== "object") return null;

  const normStr = (v: any): string | null => (typeof v === "string" ? v : null);
  const normNum = (v: any): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const oneOf = <T extends string>(v: any, values: readonly T[]): T | null =>
    typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null;

  // deadline
  let deadline: DiaGuruTaskExtraction["deadline"] = null;
  if (obj.deadline && typeof obj.deadline === "object") {
    deadline = {
      datetime: normStr(obj.deadline.datetime),
      kind: oneOf(obj.deadline.kind, ["hard", "soft"] as const),
      source: oneOf(obj.deadline.source, ["explicit", "inferred"] as const),
    };
    if (!deadline.datetime && !deadline.kind && !deadline.source) deadline = null;
  }

  // scheduled_time
  let scheduled_time: DiaGuruTaskExtraction["scheduled_time"] = null;
  if (obj.scheduled_time && typeof obj.scheduled_time === "object") {
    scheduled_time = {
      datetime: normStr(obj.scheduled_time.datetime),
      precision: oneOf(obj.scheduled_time.precision, ["exact", "approximate"] as const),
      source: oneOf(obj.scheduled_time.source, ["explicit", "inferred"] as const),
    };
    if (!scheduled_time.datetime && !scheduled_time.precision && !scheduled_time.source) scheduled_time = null;
  }

  // execution_window
  let execution_window: DiaGuruTaskExtraction["execution_window"] = null;
  if (obj.execution_window && typeof obj.execution_window === "object") {
    execution_window = {
      relation: oneOf(obj.execution_window.relation, [
        "before_deadline",
        "after_deadline",
        "around_scheduled",
        "between",
        "on_day",
        "anytime",
      ] as const),
      start: obj.execution_window.start === null ? null : normStr(obj.execution_window.start),
      end: obj.execution_window.end === null ? null : normStr(obj.execution_window.end),
      source: oneOf(obj.execution_window.source, ["explicit", "inferred", "default"] as const),
    };
    if (
      execution_window.relation === null &&
      execution_window.start === null &&
      execution_window.end === null &&
      execution_window.source === null
    ) {
      execution_window = null;
    }
  }

  // time_preferences
  let time_preferences: DiaGuruTaskExtraction["time_preferences"] = null;
  if (obj.time_preferences && typeof obj.time_preferences === "object") {
    time_preferences = {
      time_of_day: oneOf(obj.time_preferences.time_of_day, [
        "morning",
        "afternoon",
        "evening",
        "night",
      ] as const),
      day: oneOf(obj.time_preferences.day, ["today", "tomorrow", "specific_date", "any"] as const),
    };
    if (!time_preferences.time_of_day && !time_preferences.day) time_preferences = null;
  }

  const title = (() => {
    const v = normStr(obj.title);
    if (!v) return null;
    const t = v.trim();
    return t.length ? t : null;
  })();

  const estimated_minutes = normNum(obj.estimated_minutes);
  const missing = Array.isArray(obj.missing) ? obj.missing.map((x: any) => String(x)) : [];
  const clarifying_question = obj.clarifying_question == null ? null : String(obj.clarifying_question);
  const notes = Array.isArray(obj.notes) ? obj.notes.map((x: any) => String(x)) : [];

  let importance: DiaGuruTaskExtraction["importance"] = null;
  if (obj.importance && typeof obj.importance === "object") {
    const rec = obj.importance as Record<string, unknown>;
    const urg = normNum(rec.urgency);
    const imp = normNum(rec.impact);
    const pen = normNum(rec.reschedule_penalty);
    importance = {
      urgency: (urg as any) ?? null,
      impact: (imp as any) ?? null,
      reschedule_penalty: (pen as any) ?? null,
      blocking: Boolean(rec.blocking),
      rationale: typeof rec.rationale === "string" ? rec.rationale : "",
    } as any;
  }

  let flexibility: DiaGuruTaskExtraction["flexibility"] = null;
  if (obj.flexibility && typeof obj.flexibility === "object") {
    const rec = obj.flexibility as Record<string, unknown>;
    flexibility = {
      cannot_overlap: Boolean(rec.cannot_overlap),
      start_flexibility: oneOf(rec.start_flexibility, ["hard", "soft", "anytime"] as const) ?? "soft",
      duration_flexibility: oneOf(rec.duration_flexibility, ["fixed", "split_allowed"] as const) ?? "fixed",
      min_chunk_minutes: normNum(rec.min_chunk_minutes),
      max_splits: normNum(rec.max_splits),
    };
  }

  return {
    title,
    estimated_minutes,
    deadline,
    scheduled_time,
    execution_window,
    time_preferences,
    importance,
    flexibility,
    kind: typeof obj.kind === "string" ? (obj.kind as any) : null,
    missing,
    clarifying_question,
    notes,
  };
}
