# Progress Tracker (backup copy)

- [x] Facet normalizer for routines (sleep/meal): re-tag, night/mealtime windows, lower penalties, no auto-freeze for system-created routines.
- [x] Routine priority clamp/scaler: applied via routine rules + config caps.
- [x] “Before I sleep” resolver: soft deadline inferred relative to sleep; late override available.
- [x] Overlap budget: safe pairs, per-task fraction, daily cap, soft overlap cost; prime/overlapped flags; budget returned in responses.
- [ ] Time-of-day defaults (general) beyond routines: not yet added.
- [~] Hard/soft deadline ladders: guards enforced; soft late-placement flag exists; partial-plan for hard deadlines not yet implemented.
- [~] Preemption NetGain with ripple caps: basic NetGain exists; overlap soft cost folded in; full ripple search still limited to existing pathways.
- [~] Splitting/EDF packing: chunk infra exists; EDF/splitting to be expanded for multi-chunk placements.

Regression / testing:
- Regression fixture: `supabase/functions/schedule-capture/regression-fixture.json`.
- Regression runner: `supabase/functions/schedule-capture/run-regression.js` (needs SUPABASE_URL, SERVICE_ROLE_KEY, USER_ID, USER_BEARER).
- UI: shows last scheduled chunks and overlap budget (Home tab).

Recent changes:
- Scheduler: overlap engine, routine working-window bypass, late-placement override, routine priority caps/scalers, overlap budget in responses, chunk serialization on success; overlap soft cost now in NetGain evaluation/logs.
- Parse-task: routine normalization and “before I sleep” mapping; task_type_hint from extraction kind.
- App UI: “Last scheduled chunks” panel with flags and overlap budget.
- Tooling: regression fixture + runner to replay failing scenario.

Next actions:
- Add general time-of-day defaults (non-routine) and enforce search narrowing.
- Implement full splitting/EDF packing for multi-chunk tasks.
- Extend hard/soft ladder (partial_plan for hard deadlines; solidify soft Mode A/B).
- Broaden preemption ripple search and NetGain use.
- Clean `.env` files (remove shell lines) to avoid dotenv parse errors when running tools.
