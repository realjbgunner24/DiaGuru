import { connectGoogleCalendar } from '@/lib/google-connect'; // <-- add this
import { fetchProfile, upsertProfile } from '@/lib/profile';
import { Button, Input } from '@rneui/themed';
import { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Alert, AppState, StyleSheet, View } from 'react-native';
import { supabase } from '../lib/supabase';


export default function Account({ session }: { session: Session }) {
  const [loading, setLoading] = useState(true)
  const [username, setUsername] = useState('')
  const [website, setWebsite] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  

  useEffect(() => {
    if (session) getProfile()
  }, [session])

  async function getProfile() {
    try {
      setLoading(true)
      if (!session?.user) throw new Error('No user on the session!')

      const data = await fetchProfile(session.user.id)

      if (data) {
        setUsername(data.username ?? '')
        setWebsite(data.website ?? '')
        setAvatarUrl(data.avatar_url ?? '')
      }
    } catch (error) {
      if (error instanceof Error) {
        Alert.alert(error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  async function updateProfile({
    username,
    website,
    avatar_url,
  }: {
    username: string
    website: string
    avatar_url: string
  }) {
    try {
      setLoading(true)
      if (!session?.user) throw new Error('No user on the session!')

      const updates = {
        id: session?.user.id,
        username,
        website,
        avatar_url,
        updated_at: new Date().toISOString(),
      }

      await upsertProfile(updates)
    } catch (error) {
      if (error instanceof Error) {
        Alert.alert(error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const [linking, setLinking] = useState(false);
  const [googleLinked, setGoogleLinked] = useState<boolean>(false);

  useEffect(() => {
    if (session?.user) refreshGoogleStatus();
  }, [session?.user?.id]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshGoogleStatus(); // user returns from browser -> re-check
    });
    return () => sub.remove();
  }, []);

  async function refreshGoogleStatus() {
    if (!session?.user) return;
    const { data, error } = await supabase
      .from('calendar_accounts')
      .select('id')
      .eq('user_id', session.user.id)
      .eq('provider', 'google')
      .maybeSingle();
    if (!error) setGoogleLinked(!!data);
  }

  async function handleConnectGoogle() {
    try {
      setLinking(true);
      await connectGoogleCalendar(); // opens browser
      // after user returns to app, AppState effect will refresh status
    } catch (e: any) {
      Alert.alert('Google Connect failed', e?.message ?? String(e));
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
        <Input label="Username" value={username || ''} onChangeText={(text) => setUsername(text)} />
      </View>
      <View style={styles.verticallySpaced}>
        <Input label="Website" value={website || ''} onChangeText={(text) => setWebsite(text)} />
      </View>

      <View style={[styles.verticallySpaced, styles.mt20]}>
        <Button
          title={loading ? 'Loading ...' : 'Update'}
          onPress={() => updateProfile({ username, website, avatar_url: avatarUrl })}
          disabled={loading}
        />
      </View>

      <View style={[styles.verticallySpaced, styles.mt20]}>
        <Button
          title={googleLinked ? 'Google Calendar Connected' : 'Connect Google Calendar'}
          type={googleLinked ? 'outline' : 'solid'}
          disabled={linking || googleLinked}
          onPress={handleConnectGoogle}
        />
      </View>

      <View style={styles.verticallySpaced}>
        <Button title="Refresh connection" type="clear" onPress={refreshGoogleStatus} />
      </View>

      <View style={styles.verticallySpaced}>
        <Button title="Sign Out" onPress={() => supabase.auth.signOut()} />
      </View>
    </View>
    
  )
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
})