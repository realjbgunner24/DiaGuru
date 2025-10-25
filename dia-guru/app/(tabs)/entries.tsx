import { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import {
    Alert,
    Button, FlatList,
    Text, TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import {
    addEntry,
    deleteEntry,
    listMyEntries,
    updateEntry,
    type Entry,
} from '../../lib/entries';
import { supabase } from '../../lib/supabase';

export default function EntriesTab() {
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Entry[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const sessionUserId = session?.user?.id;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
  }, []);

  async function reload() {
    try {
      const rows = await listMyEntries();
      setItems(rows);
    } catch (e: any) {
      Alert.alert('Load failed', e.message ?? String(e));
    }
  }

  useEffect(() => {
    if (!sessionUserId) return;
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, [sessionUserId]);

  async function onRefresh() {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }

  async function onAdd() {
    if (!sessionUserId) return;
    const t = title.trim();
    const b = body.trim();
    if (!t && !b) return;
    try {
      setSaving(true);
      const row = await addEntry(sessionUserId, t, b);
      setItems(prev => [row, ...prev]);
      setTitle(''); setBody('');
      Alert.alert('Saved', 'Entry added.');
    } catch (e: any) {
      Alert.alert('Save failed', e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  function startEdit(item: Entry) {
    setEditingId(item.id);
    setEditTitle(item.title ?? '');
    setEditBody(item.body ?? '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditTitle('');
    setEditBody('');
  }

  async function saveEdit() {
    if (editingId == null) return;
    try {
      setEditSaving(true);
      const row = await updateEntry(editingId, editTitle.trim(), editBody.trim());
      setItems(prev => prev.map(it => (it.id === row.id ? row : it)));
      cancelEdit();
      Alert.alert('Updated', 'Entry updated.');
    } catch (e: any) {
      Alert.alert('Update failed', e.message ?? String(e));
    } finally {
      setEditSaving(false);
    }
  }

  async function onDelete(id: number) {
    Alert.alert('Delete entry?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await deleteEntry(id);
            setItems(prev => prev.filter(it => it.id !== id));
          } catch (e: any) {
            Alert.alert('Delete failed', e.message ?? String(e));
          }
        }
      }
    ]);
  }

  const renderItem = ({ item }: { item: Entry }) => {
    const isEditing = item.id === editingId;
    return (
      <View style={{ paddingVertical: 10, borderBottomWidth: 0.5, borderColor: '#E5E7EB' }}>
        {isEditing ? (
          <View style={{ gap: 8 }}>
            <TextInput
              placeholder="Title"
              placeholderTextColor="#6B7280"
              value={editTitle}
              onChangeText={setEditTitle}
              style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 10, backgroundColor: '#FFF', color: '#111827' }}
            />
            <TextInput
              placeholder="Body"
              placeholderTextColor="#6B7280"
              value={editBody}
              onChangeText={setEditBody}
              multiline
              style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 10, minHeight: 80, backgroundColor: '#FFF', color: '#111827' }}
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Button title={editSaving ? 'Saving...' : 'Save'} onPress={saveEdit} disabled={editSaving} />
              <Button title="Cancel" onPress={cancelEdit} />
            </View>
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <Text style={{ fontWeight: '600', color: '#111827' }}>{item.title || '(no title)'}</Text>
            {!!item.body && <Text style={{ color: '#111827' }}>{item.body}</Text>}
            <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
              <TouchableOpacity onPress={() => startEdit(item)}>
                <Text style={{ color: '#2563EB' }}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => onDelete(item.id)}>
                <Text style={{ color: '#DC2626' }}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, padding: 16, gap: 12, backgroundColor: '#FFFFFF' }}>
      <Text style={{ fontSize: 22, fontWeight: '600', color: '#111827' }}>My entries</Text>

      <TextInput
        placeholder="Title"
        placeholderTextColor="#6B7280"
        value={title}
        onChangeText={setTitle}
        style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 10, backgroundColor: '#FFFFFF', color: '#111827' }}
      />
      <TextInput
        placeholder="Body"
        placeholderTextColor="#6B7280"
        value={body}
        onChangeText={setBody}
        multiline
        style={{ borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 10, minHeight: 80, backgroundColor: '#FFFFFF', color: '#111827' }}
      />
      <Button title={saving ? 'Saving...' : 'Add'} onPress={onAdd} disabled={saving || (!title.trim() && !body.trim())} />

      {loading ? (
        <Text style={{ color: '#111827' }}>Loading...</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: '#6B7280' }}>No entries yet. Add your first one above.</Text>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => String(it.id)}
          renderItem={renderItem}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
    </View>
  );
}
