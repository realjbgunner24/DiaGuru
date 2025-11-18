import type { CaptureEntryRow } from "../types.ts";

type SchedulerConfig = {
  workingWindow: { startHour: number; endHour: number };
  priority: {
    urgencyWeight: number;
    impactWeight: number;
    blockingBonus: number;
    deadlineBase: number;
    hardBonus: number;
  };
  rigidity: {
    reschedulePenaltyWeight: number;
    rescheduleCountWeight: number;
    hardDeadlineWeight: number;
    slackWeight: number;
    cannotOverlapWeight: number;
    durationFixedWeight: number;
    startHardWeight: number;
    urgencyWeight: number;
    impactWeight: number;
    blockingWeight: number;
  };
  fragmentation: {
    coefficient: number;
  };
};

export const schedulerConfig: SchedulerConfig = {
  workingWindow: { startHour: 8, endHour: 22 },
  priority: {
    urgencyWeight: 10,
    impactWeight: 6,
    blockingBonus: 15,
    deadlineBase: 35,
    hardBonus: 20,
  },
  rigidity: {
    reschedulePenaltyWeight: 20,
    rescheduleCountWeight: 10,
    hardDeadlineWeight: 15,
    slackWeight: 15,
    cannotOverlapWeight: 10,
    durationFixedWeight: 10,
    startHardWeight: 5,
    urgencyWeight: 4,
    impactWeight: 2,
    blockingWeight: 8,
  },
  fragmentation: {
    coefficient: 2,
  },
};

const MS_PER_MINUTE = 60 * 1000;

const clamp01 = (value: number) => {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const getDeadlineDate = (capture: CaptureEntryRow): Date | null => {
  const candidates: (string | null)[] = [
    capture.deadline_at,
    capture.window_end,
    capture.constraint_end,
  ];

  if (capture.constraint_type === "deadline_time" && capture.constraint_time) {
    candidates.push(capture.constraint_time);
  }

  for (const iso of candidates) {
    if (!iso) continue;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
};

const getEstimatedMinutes = (capture: CaptureEntryRow) => {
  const value = capture.estimated_minutes ?? 30;
  return Math.max(5, Math.min(8 * 60, value));
};

export type PrioritySnapshot = {
  score: number;
  perMinute: number;
  components: {
    urgency: number;
    impact: number;
    blocking: number;
    deadline: number;
  };
};

export function computePrioritySnapshot(capture: CaptureEntryRow, referenceNow: Date): PrioritySnapshot {
  const minutes = getEstimatedMinutes(capture);
  const urgency = capture.urgency ?? capture.importance ?? 2;
  const impact = capture.impact ?? capture.importance ?? 2;
  const blocking = Boolean(capture.blocking);
  const deadlineDate = getDeadlineDate(capture);

  const urgencyComponent = schedulerConfig.priority.urgencyWeight * urgency;
  const impactComponent = schedulerConfig.priority.impactWeight * impact;
  const blockingComponent = blocking ? schedulerConfig.priority.blockingBonus : 0;

  let deadlineComponent = 0;
  if (deadlineDate) {
    const slackMinutes = deadlineDate.getTime() - referenceNow.getTime();
    const slack = slackMinutes / MS_PER_MINUTE - minutes;
    const base = schedulerConfig.priority.deadlineBase * clamp01(1 - slack / (2 * minutes));
    const hardBonus = capture.deadline_at && capture.constraint_type === "deadline_time"
      ? schedulerConfig.priority.hardBonus
      : 0;
    deadlineComponent = base + hardBonus;
  }

  const score = urgencyComponent + impactComponent + blockingComponent + deadlineComponent;
  const perMinute = score / minutes;

  return {
    score,
    perMinute,
    components: {
      urgency: urgencyComponent,
      impact: impactComponent,
      blocking: blockingComponent,
      deadline: deadlineComponent,
    },
  };
}

export function computeRigidityScore(capture: CaptureEntryRow, referenceNow: Date) {
  const config = schedulerConfig.rigidity;
  const slackDeadline = getDeadlineDate(capture);
  const minutes = getEstimatedMinutes(capture);
  let slackComponent = 0;
  if (slackDeadline) {
    const slackMinutes = slackDeadline.getTime() - referenceNow.getTime();
    const slack = slackMinutes / MS_PER_MINUTE - minutes;
    slackComponent = config.slackWeight * clamp01((minutes - slack) / minutes);
  }

  return (
    (capture.reschedule_penalty ?? 0) * config.reschedulePenaltyWeight +
    (capture.reschedule_count ?? 0) * config.rescheduleCountWeight +
    (capture.deadline_at ? config.hardDeadlineWeight : 0) +
    slackComponent +
    (capture.cannot_overlap ? config.cannotOverlapWeight : 0) +
    (capture.duration_flexibility === "fixed" ? config.durationFixedWeight : 0) +
    (capture.start_flexibility === "hard" ? config.startHardWeight : 0) +
    (capture.urgency ?? 0) * config.urgencyWeight +
    (capture.impact ?? 0) * config.impactWeight +
    (capture.blocking ? config.blockingWeight : 0)
  );
}

export function computeRescheduleCost(
  capture: CaptureEntryRow,
  minutesMoved: number,
  referenceNow: Date,
) {
  const rigidity = computeRigidityScore(capture, referenceNow);
  const ratio = minutesMoved / getEstimatedMinutes(capture);
  const base = ratio * rigidity;
  const fragmentation = schedulerConfig.fragmentation.coefficient * Math.sqrt(Math.max(1, minutesMoved));
  return base + fragmentation;
}

export function logSchedulerEvent(event: string, payload: Record<string, unknown>) {
  try {
    console.log(`[dg.schedule] ${event}`, payload);
  } catch {
    // no-op
  }
}
