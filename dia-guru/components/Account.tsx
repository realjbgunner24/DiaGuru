import { connectGoogleCalendar } from '@/lib/google-connect';
import { fetchProfile, upsertProfile } from '@/lib/profile';
import { Button, Input } from '@rneui/themed';
import { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';

export default function Account({ session }: { session: Session }) {
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [website, setWebsite] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');

  const [linking, setLinking] = useState(false);
  const [checkingGoogle, setCheckingGoogle] = useState(false);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const userId = session?.user?.id;

  const getProfile = useCallback(async () => {
    try {
      setLoading(true);
      if (!userId) throw new Error('No user on the session!');

      const data = await fetchProfile(userId);

      if (data) {
        setUsername(data.username ?? '');
        setWebsite(data.website ?? '');
        setAvatarUrl(data.avatar_url ?? '');
      }
    } catch (error) {
      if (error instanceof Error) {
        Alert.alert(error.message);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const refreshGoogleStatus = useCallback(async () => {
    if (!userId) return;
    setCheckingGoogle(true);
    setGoogleError(null);
    try {
      const { data, error } = await supabase
        .from('calendar_accounts')
        .select('id')
        .eq('user_id', userId)
        .eq('provider', 'google')
        .maybeSingle();
      if (error) throw error;
      setGoogleLinked(!!data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGoogleLinked(false);
      setGoogleError(message);
    } finally {
      setCheckingGoogle(false);
    }
  }, [userId]);

  useEffect(() => {
    if (session) getProfile();
  }, [session, getProfile]);

  useEffect(() => {
    if (userId) refreshGoogleStatus();
  }, [userId, refreshGoogleStatus]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshGoogleStatus(); // user returns from browser -> re-check
    });
    return () => sub.remove();
  }, [refreshGoogleStatus]);

  async function updateProfile({
    username,
    website,
    avatar_url,
  }: {
    username: string;
    website: string;
    avatar_url: string;
  }) {
    try {
      setLoading(true);
      if (!userId) throw new Error('No user on the session!');

      const updates = {
        id: userId,
        username,
        website,
        avatar_url,
        updated_at: new Date().toISOString(),
      };

      await upsertProfile(updates);
    } catch (error) {
      if (error instanceof Error) {
        Alert.alert(error.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleConnectGoogle() {
    try {
      setLinking(true);
      setGoogleError(null);
      await connectGoogleCalendar(); // opens browser
      Alert.alert(
        'Check your browser',
        'Approve Google Calendar access, then return to DiaGuru to finish linking.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGoogleError(message);
      Alert.alert('Google connect failed', message);
    } finally {
      setLinking(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={[styles.verticallySpaced, styles.mt20]}>
        <Input label="Email" value={session?.user?.email} disabled />
      </View>
      <View style={styles.verticallySpaced}>
        <Input label="Username" value={username || ''} onChangeText={setUsername} />
      </View>
      <View style={styles.verticallySpaced}>
        <Input label="Website" value={website || ''} onChangeText={setWebsite} />
      </View>

      <View style={[styles.verticallySpaced, styles.mt20]}>
        <Button
          title={loading ? 'Loading...' : 'Update'}
          onPress={() => updateProfile({ username, website, avatar_url: avatarUrl })}
          disabled={loading}
        />
      </View>

      <View style={[styles.verticallySpaced, styles.mt20]}>
        <Button
          title={
            linking
              ? 'Opening browser...'
              : checkingGoogle
                ? 'Checking status...'
                : googleLinked
                  ? 'Google Calendar Connected'
                  : 'Connect Google Calendar'
          }
          type={googleLinked ? 'outline' : 'solid'}
          disabled={linking || checkingGoogle || googleLinked}
          onPress={handleConnectGoogle}
        />
        <Text style={styles.statusText}>
          Google Calendar: {googleLinked ? 'Linked' : 'Not linked'}
        </Text>
        {googleError ? <Text style={styles.errorText}>{googleError}</Text> : null}
      </View>

      <View style={styles.verticallySpaced}>
        <Button
          title={checkingGoogle ? 'Refreshing...' : 'Refresh connection'}
          type="clear"
          onPress={refreshGoogleStatus}
          disabled={checkingGoogle}
        />
      </View>

      <View style={styles.verticallySpaced}>
        <Button title="Sign Out" onPress={() => supabase.auth.signOut()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 40,
    padding: 12,
  },
  verticallySpaced: {
    paddingTop: 4,
    paddingBottom: 4,
    alignSelf: 'stretch',
  },
  mt20: {
    marginTop: 20,
  },
  statusText: {
    marginTop: 8,
    color: '#4B5563',
  },
  errorText: {
    marginTop: 4,
    color: '#DC2626',
  },
});
