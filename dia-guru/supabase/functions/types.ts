export type CaptureEntryRow = {
  id: string;
  user_id: string;
  content: string;
  estimated_minutes: number | null;
  importance: number;
  status: string;
  calendar_event_id: string | null;
  planned_start: string | null;
  planned_end: string | null;
  last_check_in: string | null;
  scheduling_notes?: string | null;
};

export type CalendarTokenRow = {
  account_id: number;
  access_token: string;
  refresh_token: string | null;
  expiry: string | null;
};

export type Database = {
  public: {
    Tables: {
      capture_entries: { Row: CaptureEntryRow };
      calendar_accounts: { Row: { id: number; user_id: string; provider: string } };
      calendar_tokens: { Row: CalendarTokenRow };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
