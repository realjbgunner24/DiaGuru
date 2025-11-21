# DiaGuru Scheduling/Parsing Overview (for external analysis)

## Core components
- **Parsing (supabase/functions/parse-task)**  
  - Uses DeepSeek (`conversational_strict`) to extract: estimated_minutes, constraint_type (deadline/start/window/flexible), deadline_at/window, start_flexibility, duration_flexibility, cannot_overlap, urgency/impact/reschedule_penalty/blocking, task_type_hint, time_pref_day/time_pref_time_of_day.  
  - Normalization for routines: sleep/meal retagged (`routine.sleep` / `routine.meal`), night/mealtime windows inferred, penalties lowered, “before I sleep” mapped to a soft, relative bedtime. `task_type_hint` comes from extracted kind.

- **Scheduler (supabase/functions/schedule-capture)**  
  - Working window: 08:00–22:00 local, 15-min grid.  
  - Priority weights: urgency*10 + impact*6 + blocking bonus + deadline weight; routine caps/scalers applied.  
  - Rigidity/reschedule cost: penalties, counts, hard deadline weight, slack weight, cannot_overlap, fixed duration, start hard, urgency/impact, blocking.  
  - Overlap engine: safe pairs only (no external/blocked/hard-start), max concurrency 2, daily budget (default 90m), per-task overlap fraction (0.5), soft cost per minute, prime/background flags, overlap budget returned in response.  
  - Late placement override flag (`allowLatePlacement`) and routine working-window bypass.  
  - Chunks table + serialization: every schedule writes chunk(s) with flags (late, overlapped, prime). UI shows last chunks and overlap budget.

- **Preemption (current state)**  
  - NetGain computed as benefit – reschedule cost (now includes overlap soft cost), thresholds and ripple caps exist, but the grid-based ripple search is still conservative; frozen items and hard starts often block reclaiming time.

- **UI**  
  - Home tab shows queue, scheduled items, recent plan summary, last scheduled chunks, overlap budget.

## Current issues seen
1) **Sleep pinned in working hours**  
   - Example: `Sleep today at 12am` became `start_time 06:00Z` but was scheduled 14:15–22:15Z with `freeze_until` set. It crowds out evening tasks (“Code and plan day tonight”, “Apply to jobs tonight”), because it’s treated as a fixed start instead of a night window.

2) **Urgent deadlines blocked / late**  
   - “Assignment due in 2 hours” (hard, 120m) stays pending/no_slot once window is passed. Preemption doesn’t reclaim enough time and late-placement for hard deadlines isn’t used.  
   - “Submit graduation request by tomorrow night” is scheduled but frozen; it won’t rebalance when new urgent tasks arrive.

3) **Time-of-day preferences not enforced for non-routines**  
   - Items with evening/night intent (“Code and plan day tonight”, “Apply to jobs before sleep”) still get placed next day or afternoon because the search doesn’t narrow to preferred periods.

4) **Routine vs deliverable weighting still off**  
   - Routine sleep with freeze + high urgency/impact dominates evening. Meals not always confined to realistic mealtime windows.

5) **Past-deadline behavior**  
   - Tasks whose deadline/window has passed just fail with 409; no partial_plan or “schedule after deadline?” flow implemented yet.

6) **Plan summary clutter**  
   - `plan_summary` rows like `scheduled:1 moved:0 unscheduled:0` are expected bookkeeping but can be confusing; not a scheduler bug.

## Missing / next work (from roadmap)
- Enforce **time-of-day defaults** for all tasks (not just routines) by narrowing the search window when `time_pref_time_of_day` is set.
- **Routine cleanup** in DB: unfreeze system-created routines; convert start_time sleeps inside working hours into night windows; ensure cannot_overlap stays true for sleep; set soft starts.
- **Preemption/ripple**: broaden candidate moves for urgent hard deadlines; allow reclaiming from lower-priority, non-frozen tasks within ripple caps.
- **Splitting/EDF**: real multi-chunk placement with min_chunk/max_splits, earliest-finish packing.
- **Soft/hard ladders**: optional partial_plan for hard deadlines; Mode A/B for soft (front-fill vs defer-as-whole) fully applied.
- **Late placement UX**: allow user opt-in to schedule after deadline when no pre-deadline slot exists.

## Concrete problematic examples (from current data)
- Sleep (`id 230194d5-…`): `start_time 06:00Z`, scheduled 14:15–22:15Z with `freeze_until`, blocking evening.  
- “Assignment due in 2 hours” (`id 3a627c3b-…`): hard deadline already passed; remains pending/no_slot.  
- “Code and plan day tonight” (`id 215e8a25-…`) scheduled 02:00–04:00Z next day despite “tonight”.  
- “Apply to jobs before tomorrow” got flex slot next afternoon; “Apply to jobs before sleep” couldn’t front-fill because sleep block ate the evening.  
- “Submit graduation request by tomorrow night” frozen; won’t move even if conflicts arise.
