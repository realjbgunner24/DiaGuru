import { supabase } from '@/lib/supabase';

export type SimpleEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
};

export async function fetchUpcomingEvents(rangeDays = 7) {
  const { data, error } = await supabase.functions.invoke('calendar-list', {
    body: { rangeDays },
  });
  if (error) throw error;
  return (data?.items ?? []) as SimpleEvent[];
}
