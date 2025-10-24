import { supabase } from './supabase';

export type Entry = {
  id: number;
  user_id: string;
  title: string | null;
  body: string | null;
  created_at: string;  // timestamptz → string
  updated_at: string;  // timestamptz → string
};

export async function listMyEntries() {
  const { data, error } = await supabase
    .from('entries')
    .select('id,title,body,created_at,updated_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Entry[];
}

export async function addEntry(userId: string, title: string, body: string) {
  const { data, error } = await supabase
    .from('entries')
    .insert({ user_id: userId, title, body })
    .select('id,title,body,created_at,updated_at')
    .single();
  if (error) throw error;
  return data as Entry;
}
