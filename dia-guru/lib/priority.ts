export type PriorityInput = {
  estimated_minutes: number | null;
  importance: number;
  created_at: string;
};

export function computePriorityScore(entry: PriorityInput, referenceDate = new Date()): number {
  const minutes = entry.estimated_minutes ?? 30;
  const cappedMinutes = Math.min(Math.max(minutes, 5), 240);
  const durationPenalty = cappedMinutes / 60;
  const importanceBoost = entry.importance * 2;

  const created = new Date(entry.created_at).getTime();
  const now = referenceDate.getTime();
  const recencyBoost = Math.max(0, now - created) / 1000 / 60 / 60 / 24;

  return importanceBoost - durationPenalty + recencyBoost * 0.2;
}
