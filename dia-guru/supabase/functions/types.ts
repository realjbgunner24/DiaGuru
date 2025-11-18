export type CaptureEntryRow = {
  id: string;
  user_id: string;
  content: string;
  estimated_minutes: number | null;
  importance: number;
  urgency?: number | null;
  impact?: number | null;
  reschedule_penalty?: number | null;
  blocking?: boolean | null;
  status: string;
  scheduled_for?: string | null;
  created_at?: string;
  updated_at?: string;
  calendar_event_id: string | null;
  calendar_event_etag: string | null;
  planned_start: string | null;
  planned_end: string | null;
  last_check_in: string | null;
  scheduling_notes?: string | null;
  constraint_type: string;
  constraint_time: string | null;
  constraint_end: string | null;
  constraint_date: string | null;
  original_target_time: string | null;
  deadline_at: string | null;
  window_start: string | null;
  window_end: string | null;
  start_target_at: string | null;
  is_soft_start: boolean;
  cannot_overlap?: boolean | null;
  start_flexibility?: string | null;
  duration_flexibility?: string | null;
  min_chunk_minutes?: number | null;
  max_splits?: number | null;
  extraction_kind?: string | null;
  time_pref_time_of_day?: string | null;
  time_pref_day?: string | null;
  importance_rationale?: string | null;
  externality_score: number;
  reschedule_count: number;
  task_type_hint: string | null;
  freeze_until: string | null;
  plan_id: string | null;
  manual_touch_at: string | null;
};


export type CaptureChunkRow = {
  id: string;
  capture_id: string;
  start: string;
  end: string;
  late: boolean;
  overlapped: boolean;
  prime: boolean;
  created_at?: string;
};

export type CalendarTokenRow = {
  account_id: number;
  access_token: string;
  refresh_token: string | null;
  expiry: string | null;
};

export type CalendarAccountRow = {
  id: number;
  user_id: string;
  provider: string;
  needs_reconnect: boolean;
};

export type PlanRunRow = {
  id: string;
  user_id: string;
  summary: string | null;
  created_at: string;
  undone_at: string | null;
  undo_user_id: string | null;
};

export type PlanActionRow = {
  id: string;
  plan_id: string;
  action_id: string;
  capture_id: string;
  capture_content: string;
  action_type: "scheduled" | "rescheduled" | "unscheduled";
  prev_status: string | null;
  prev_planned_start: string | null;
  prev_planned_end: string | null;
  prev_calendar_event_id: string | null;
  prev_calendar_event_etag: string | null;
  prev_freeze_until: string | null;
  prev_plan_id: string | null;
  next_status: string | null;
  next_planned_start: string | null;
  next_planned_end: string | null;
  next_calendar_event_id: string | null;
  next_calendar_event_etag: string | null;
  next_freeze_until: string | null;
  next_plan_id: string | null;
  performed_at: string;
};

export type Database = {
  public: {
    Tables: {
      capture_entries: { Row: CaptureEntryRow };
      capture_chunks: { Row: CaptureChunkRow };
      calendar_accounts: { Row: CalendarAccountRow };
      calendar_tokens: { Row: CalendarTokenRow };
      plan_runs: { Row: PlanRunRow };
      plan_actions: { Row: PlanActionRow };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

