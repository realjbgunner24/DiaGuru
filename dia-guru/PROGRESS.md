# Progress Notes (following dia_guru_implementation_plan.md)

## Step 1 - Instrumentation and Logging (completed)
- Added structured request logging in scheduler (`schedule.request`, `schedule.success`, `schedule.conflict`) capturing capture id/content, constraints, flexibility, slots/overlap, conflicts, and notes.
- Added parsing summary log `[dg.parse] summary` with extracted minutes, constraints, flexibility, importance, time prefs, and kind to baseline DeepSeek output.

## Step 2 - Normalize Routine Tasks (in progress)
- Implemented on-the-fly routine normalization in `supabase/functions/schedule-capture/index.ts` before scheduling:
  - Detect `routine.sleep`/`routine.meal` (task_type_hint or extraction_kind).
  - Sleep: convert to a night window (22:00–07:30 next day) if missing/incorrect, set `constraint_type=window`, soft start, fixed duration, `cannot_overlap=true`, default time_pref `night`, clear `freeze_until` if not user-locked.
  - Meal: default window 12:00–14:00 if missing, set soft start + fixed duration, clear `freeze_until` if not user-locked.
  - Normalize is persisted back to `capture_entries` so wrongly placed daytime sleep blocks should slide to night on next schedule/reschedule.

Pending for Step 2:
- Broader time-of-day defaults beyond routines (scheduled for Step 3).
- DB cleanup script for existing bad routines (considered after observing new behavior).

How to test (Step 2):
- Create or reschedule a sleep capture with a bad start_time in the day (e.g., “Sleep today at 12am” saved as start_time 06:00Z). Run `schedule-capture` for it; verify it moves to a night window and `freeze_until` is cleared unless manually locked.
- Create a meal capture without a window; schedule it and verify it receives a 12:00–14:00 window and remains movable.
- Inspect logs (`schedule.request`/`schedule.success`) to confirm the normalized constraints and flags.

## Step 3 - Time-of-Day Preferences (in progress)
- Added preferred time-of-day bands derived from `time_pref_time_of_day` (morning/afternoon/evening/night) with hour ranges (08-12, 12-17, 17-21, 21-26). If none provided, fallback to `schedulerConfig.timeOfDayDefaults` (now includes routine bands).
- Scheduler now passes these bands into slot search so tasks with preferences try those periods first before falling back to standard search.

How to test (Step 3):
- Create tasks with `time_pref_time_of_day` set (e.g., “Code tonight”, “Apply before bed”, “Morning workout”) and schedule; verify slots land in the preferred band. Check logs to see preferred bands used.
- For routine.tasks, ensure defaults apply: sleep targets night band, meals target mealtime bands when no explicit preference.
