const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const DEFAULT_DURATION_MINUTES = 30;
const BUFFER_MINUTES = 30;
const EPSILON_MS = 5 * MS_PER_MINUTE;

const DEADLINE_NUMERATOR_MS = 86_400_000; // 24 hours
const DEADLINE_COMPONENT_MAX = 10;
const SOFT_START_MULTIPLIER = 0.5;

const WINDOW_SOON_MS = 6 * MS_PER_HOUR;

const W_DEADLINE = 4;
const W_IMPORTANCE = 3;
const W_EXTERNAL = 2;
const W_AGING = 1;
const W_WINDOW = 1;
const W_DURATION = 0.75;
const W_RESCHEDULE = 1;

const AGE_GAIN_PER_DAY = 0.15;
const RESCHEDULE_UNIT = 0.5;

export type ConstraintKind =
  | "flexible"
  | "deadline_time"
  | "deadline_date"
  | "start_time"
  | "window";

export type PriorityInput = {
  estimated_minutes: number | null;
  importance: number;
  urgency?: number | null;
  impact?: number | null;
  reschedule_penalty?: number | null;
  created_at: string;
  constraint_type?: ConstraintKind | string | null;
  constraint_time?: string | null;
  constraint_end?: string | null;
  constraint_date?: string | null;
  original_target_time?: string | null;
  deadline_at?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  start_target_at?: string | null;
  is_soft_start?: boolean | null;
  externality_score?: number | null;
  reschedule_count?: number | null;
};

export function computePriorityScore(
  entry: PriorityInput,
  referenceDate = new Date(),
): number {
  const durationMinutes = clamp(
    entry.estimated_minutes ?? DEFAULT_DURATION_MINUTES,
    MIN_DURATION_MINUTES,
    MAX_DURATION_MINUTES,
  );
  const durationMs = durationMinutes * MS_PER_MINUTE;
  const urgNorm = clamp(((entry.urgency ?? 0) as number) / 5, 0, 1);
  const impNorm = clamp(((entry.impact ?? 0) as number) / 5, 0, 1);
  const hasRich = (entry.urgency ?? null) !== null || (entry.impact ?? null) !== null;
  const importanceNorm = hasRich ? 0.6 * urgNorm + 0.4 * impNorm : clamp((entry.importance ?? 1) / 3, 0, 1);
  const externalityComponent = clamp((entry.externality_score ?? 0) / 3, 0, 1);

  const createdTs = Date.parse(entry.created_at ?? "");
  const ageDays =
    Number.isFinite(createdTs) && createdTs > 0
      ? Math.max(0, (referenceDate.getTime() - createdTs) / MS_PER_DAY)
      : 0;

  const deadlineComponent = computeDeadlineComponent(entry, referenceDate, durationMs);
  const windowComponent = computeWindowComponent(entry, referenceDate);

  const reschedulePenalty = (entry.reschedule_count ?? 0) * RESCHEDULE_UNIT + clamp((entry.reschedule_penalty ?? 0) / 3, 0, 1);
  const durationPenalty = durationMs / MS_PER_HOUR;

  return (
    W_DEADLINE * deadlineComponent +
    W_WINDOW * windowComponent +
    W_IMPORTANCE * importanceNorm +
    W_EXTERNAL * externalityComponent +
    W_AGING * (ageDays * AGE_GAIN_PER_DAY) -
    W_DURATION * durationPenalty -
    W_RESCHEDULE * reschedulePenalty
  );
}

function computeDeadlineComponent(
  entry: PriorityInput,
  referenceDate: Date,
  durationMs: number,
) {
  const deadline = resolveDeadline(entry);
  if (!deadline) return 0;
  const bufferMs = BUFFER_MINUTES * MS_PER_MINUTE;
  const latestStart = deadline.timestamp - bufferMs - durationMs;
  const slackMs = latestStart - referenceDate.getTime();
  if (slackMs <= 0) {
    const overdue = DEADLINE_COMPONENT_MAX;
    return deadline.isSoft ? overdue * SOFT_START_MULTIPLIER : overdue;
  }
  const effectiveSlack = Math.max(slackMs, EPSILON_MS);
  let component = DEADLINE_NUMERATOR_MS / effectiveSlack;
  component = clamp(component, 0, DEADLINE_COMPONENT_MAX);
  if (deadline.isSoft) {
    component *= SOFT_START_MULTIPLIER;
  }
  return component;
}

function computeWindowComponent(entry: PriorityInput, referenceDate: Date) {
  const windowStartIso = entry.window_start ?? entry.constraint_time;
  if (!windowStartIso) return 0;
  const windowStart = Date.parse(windowStartIso);
  if (!Number.isFinite(windowStart)) return 0;
  const deltaMs = windowStart - referenceDate.getTime();
  if (deltaMs <= 0) return 1;
  if (deltaMs > WINDOW_SOON_MS) return 0;
  return clamp((WINDOW_SOON_MS - deltaMs) / WINDOW_SOON_MS, 0, 1);
}

function resolveDeadline(entry: PriorityInput) {
  const candidates: { iso: string; isSoft?: boolean }[] = [];
  if (entry.deadline_at) candidates.push({ iso: entry.deadline_at });
  if (entry.window_end) candidates.push({ iso: entry.window_end });
  if (entry.constraint_end) candidates.push({ iso: entry.constraint_end });
  if (entry.start_target_at) {
    candidates.push({ iso: entry.start_target_at, isSoft: Boolean(entry.is_soft_start) });
  }

  if (entry.constraint_type === "deadline_time" && entry.constraint_time) {
    candidates.push({ iso: entry.constraint_time });
  }

  if (entry.constraint_type === "deadline_date" && entry.constraint_date) {
    const endOfDay = buildEndOfDay(entry.constraint_date);
    if (endOfDay) candidates.push({ iso: endOfDay });
  }

  if (entry.original_target_time) {
    candidates.push({ iso: entry.original_target_time });
  }

  for (const candidate of candidates) {
    const ts = Date.parse(candidate.iso);
    if (Number.isFinite(ts)) {
      return { timestamp: ts, isSoft: Boolean(candidate.isSoft) };
    }
  }
  return null;
}

function buildEndOfDay(dateString: string) {
  if (!dateString) return null;
  const parsed = Date.parse(`${dateString}T23:59:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
