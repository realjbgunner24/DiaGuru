import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = "https://wnjykvdliwjeeytbfeux.supabase.co"
const supabasePublishableKey = "sb_publishable_KcRgtp_vagPzSrLXEmRbqw_zJW0348n"

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})