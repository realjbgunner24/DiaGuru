import { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Alert, Button, FlatList, Text, TextInput, View } from 'react-native';
import { addEntry, listMyEntries, type Entry } from '../../lib/entries';
import { supabase } from '../../lib/supabase';

export default function EntriesTab() {
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Entry[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!session?.user) return;
    (async () => {
      try {
        setLoading(true);
        const rows = await listMyEntries();
        if (mounted) setItems(rows);
      } catch (e: any) {
        Alert.alert('Load failed', e.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [session?.user?.id]);

  async function onAdd() {
    if (!session?.user) return;
    if (!title.trim() && !body.trim()) return;
    try {
      setSaving(true);
      const row = await addEntry(session.user.id, title.trim(), body.trim());
      setItems(prev => [row, ...prev]);
      setTitle('');
      setBody('');
    } catch (e: any) {
      Alert.alert('Save failed', e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '600' }}>My entries</Text>

      <TextInput
        placeholder="Title"
        value={title}
        onChangeText={setTitle}
        style={{ borderWidth: 1, borderRadius: 8, padding: 10 }}
      />
      <TextInput
        placeholder="Body"
        value={body}
        onChangeText={setBody}
        multiline
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 80 }}
      />
      <Button title={saving ? 'Saving…' : 'Add'} onPress={onAdd} disabled={saving} />

      {loading ? (
        <Text>Loading…</Text>
      ) : items.length === 0 ? (
        <Text style={{ opacity: 0.7 }}>No entries yet. Add your first one above.</Text>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => String(it.id)}
          renderItem={({ item }) => (
            <View style={{ paddingVertical: 10, borderBottomWidth: 0.5 }}>
              <Text style={{ fontWeight: '600' }}>{item.title || '(no title)'}</Text>
              {!!item.body && <Text>{item.body}</Text>}
            </View>
          )}
        />
      )}
    </View>
  );
}
