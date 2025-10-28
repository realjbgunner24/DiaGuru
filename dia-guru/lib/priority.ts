export type PriorityInput = {
  estimated_minutes: number | null;
  importance: number;
  created_at: string;
  constraint_type?: string | null;
  constraint_time?: string | null;
  constraint_date?: string | null;
  original_target_time?: string | null;
};

const DEADLINE_OVERDUE_BONUS = 30;
const DEADLINE_NEAR_WINDOW_HOURS = 48;
const DEADLINE_NEAR_MULTIPLIER = 3;
const START_TIME_WINDOW_HOURS = 12;

export function computePriorityScore(entry: PriorityInput, referenceDate = new Date()): number {
  const minutes = entry.estimated_minutes ?? 30;
  const cappedMinutes = Math.min(Math.max(minutes, 5), 240);
  const durationPenalty = cappedMinutes / 60;
  const importanceBoost = entry.importance * 2;

  const created = new Date(entry.created_at).getTime();
  const now = referenceDate.getTime();
  const recencyBoost = Math.max(0, now - created) / 1000 / 60 / 60 / 24;

  const deadlineBoost = computeConstraintBoost(entry, referenceDate);

  return importanceBoost - durationPenalty + recencyBoost * 0.2 + deadlineBoost;
}

function computeConstraintBoost(entry: PriorityInput, referenceDate: Date): number {
  const type = entry.constraint_type ?? 'flexible';
  const targets: Date[] = [];

  if (entry.constraint_time) {
    const parsed = new Date(entry.constraint_time);
    if (!Number.isNaN(parsed.getTime())) targets.push(parsed);
  }

  if (entry.original_target_time) {
    const parsed = new Date(entry.original_target_time);
    if (!Number.isNaN(parsed.getTime())) targets.push(parsed);
  }

  if (type === 'deadline_date' && entry.constraint_date) {
    const parsed = new Date(entry.constraint_date);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setHours(23, 59, 0, 0);
      targets.push(parsed);
    }
  }

  if (targets.length === 0) return 0;

  const soonest = targets.reduce((soonestDate, current) => {
    if (!soonestDate) return current;
    return current.getTime() < soonestDate.getTime() ? current : soonestDate;
  }, targets[0]);

  const hoursUntil = (soonest.getTime() - referenceDate.getTime()) / 1000 / 60 / 60;

  if (type === 'deadline_time' || type === 'deadline_date') {
    if (hoursUntil <= 0) return DEADLINE_OVERDUE_BONUS;
    if (hoursUntil <= DEADLINE_NEAR_WINDOW_HOURS) {
      return (DEADLINE_NEAR_WINDOW_HOURS - hoursUntil) / DEADLINE_NEAR_WINDOW_HOURS * DEADLINE_NEAR_MULTIPLIER * entry.importance;
    }
    return 0;
  }

  if (type === 'start_time' || type === 'window') {
    if (hoursUntil <= 0) return START_TIME_WINDOW_HOURS;
    if (hoursUntil <= START_TIME_WINDOW_HOURS) {
      return (START_TIME_WINDOW_HOURS - hoursUntil) / START_TIME_WINDOW_HOURS * entry.importance;
    }
  }

  return 0;
}
