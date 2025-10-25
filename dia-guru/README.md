# DiaGuru

DiaGuru is an Expo Router application for people living with diabetes. It combines secure Supabase authentication, an on-device journal, Google Calendar integration, and Expo Notifications so that users can keep track of their daily entries and upcoming healthcare events in one place.

## Features
- Email/password authentication backed by Supabase with persistent sessions.
- Profile editor that stores user metadata in the `profiles` table.
- Journal tab with create, update, delete, and pull-to-refresh behaviour for the `entries` table.
- Google Calendar linking through Supabase Edge Functions (`oauth-cb` and `calendar-list`) to surface upcoming events inside the app.
- Notification utilities to request permissions, send an immediate local notification, or schedule a reminder.

## Prerequisites
- Node.js 18 or newer and npm 9+.
- Expo CLI (`npm install -g expo-cli`) if you prefer the global binary.
- A Supabase project with the schema used by this app (`profiles`, `entries`, `calendar_accounts`, `calendar_tokens`).
- A Google Cloud project with OAuth consent screen and a Web OAuth client ID for Calendar access.

## Environment configuration
1. Copy `.env.example` to `.env` (Expo automatically loads it):
   ```bash
   cp .env.example .env
   ```
2. Fill in the following values:
   - `EXPO_PUBLIC_SUPABASE_URL` - your Supabase project URL.
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` - the public (anon) API key.
   - `EXPO_PUBLIC_GOOGLE_CLIENT_ID` - Google OAuth Web client ID created for the project.
   - `EXPO_PUBLIC_GOOGLE_REDIRECT_URI` - the deployed Edge Function callback URL (see below).

The mobile app reads these values at runtime (`lib/supabase.ts` and `lib/google-connect.ts`). The Supabase publishable key is no longer hard-coded, so a missing value will throw an error during startup.

### Supabase Edge Function secrets
Deploy the functions under `supabase/functions` and configure the following environment variables for each function (via the Supabase dashboard or CLI):

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Automatically injected when using `supabase functions deploy`. |
| `SERVICE_ROLE_KEY` | Required so the `calendar-list` function can read/write token tables. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth credentials that match the Expo app. |
| `GOOGLE_REDIRECT_URI` | Should match the deployed URL of `oauth-cb` (`https://<project>.functions.supabase.co/oauth-cb`). |

## Running the app
```bash
npm install
npx expo start
```
Choose the target (Expo Go, Android emulator, iOS simulator, or development build) from the Expo CLI prompt.

### Useful scripts
- `npm run dev` / `npm run start` - launch Metro bundler.
- `npm run dev:lan` - start Metro with LAN tunnelling.
- `npm run dev:offline` - start in offline mode when you know the local IP.
- `npm run lint` - run ESLint with Expo defaults.
- `npm run reset-project` - revert to a blank template if you want a clean slate.

## Google Calendar linking flow
1. A signed-in user taps **Connect Google Calendar** (`components/Account.tsx`).
2. `lib/google-connect.ts` opens the Google OAuth consent screen in the browser using the Supabase session access token as `state`.
3. After the user approves access, the `oauth-cb` function exchanges the authorization code, stores access/refresh tokens in `calendar_tokens`, and links the account.
4. Back in the app, the Account screen refreshes the status. The Home tab calls `supabase.functions.invoke('calendar-list')` to fetch upcoming events and displays them in `app/(tabs)/index.tsx`.

If you need to reset tokens during development, clear the `calendar_accounts` and `calendar_tokens` rows for your user in Supabase.

## Notifications
The Settings tab (`app/(tabs)/settings.tsx`) exposes helper buttons that exercise the logic in `lib/notifications.ts`. Remember that iOS requires an actual device or TestFlight build for scheduled notifications.

## Troubleshooting
- **"Missing Supabase environment variables"** - ensure `.env` is present with `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` before starting Metro.
- **Calendar list returns 404** - the Supabase user has not linked Google yet, or the function is missing secrets. Link again from the Account tab.
- **OAuth callback fails** - confirm `GOOGLE_REDIRECT_URI` in both the Edge Function environment and Google Cloud console match exactly.

With the environment set up, you can continue iterating on tabs, styling, or additional data sources with the assurance that authentication, calendar sync, and notifications are already in place.
