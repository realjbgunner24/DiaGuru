// lib/profile.ts
import { supabase } from './supabase';

export type Profile = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  website: string | null;
  updated_at: string | null;
};

export async function fetchProfile(id: string) {
  const { data, error, status } = await supabase
    .from('profiles')
    .select('id, username, full_name, website, avatar_url, updated_at')
    .eq('id', id)
    .single();
  if (error && status !== 406) throw error;
  return data as Profile | null;
}

export async function upsertProfile(p: Partial<Profile> & { id: string }) {
  const { error } = await supabase.from('profiles').upsert(p);
  if (error) throw error;
}
