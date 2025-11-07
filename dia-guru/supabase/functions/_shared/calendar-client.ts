import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalendarAccountRow, CalendarTokenRow, Database } from "../types.ts";

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

type CalendarClientCredentials = {
  accountId: number;
  accessToken: string;
  refreshToken: string | null;
  refreshed: boolean;
};

export async function resolveCalendarClient(
  admin: SupabaseClient<Database, "public">,
  userId: string,
  clientId: string,
  clientSecret: string,
) {
  const { data: account, error: accountError } = await admin
    .from("calendar_accounts")
    .select("id, needs_reconnect")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single();
  if (accountError || !account) return null;

  const accountRow = account as CalendarAccountRow;

  const { data: tokenRow, error: tokenError } = await admin
    .from("calendar_tokens")
    .select("access_token, refresh_token, expiry")
    .eq("account_id", account.id)
    .single();
  if (tokenError || !tokenRow) {
    await setCalendarReconnectFlag(admin, accountRow.id, true);
    return null;
  }

  const typedToken = tokenRow as CalendarTokenRow;

  const credentials: CalendarClientCredentials = {
    accountId: accountRow.id,
    accessToken: typedToken.access_token,
    refreshToken: typedToken.refresh_token,
    refreshed: false,
  };

  const expiryMillis = typedToken.expiry ? Date.parse(typedToken.expiry) : 0;
  const expiryIsValid = Number.isFinite(expiryMillis) && expiryMillis > 0;
  const alreadyExpired = expiryIsValid ? expiryMillis <= Date.now() : true;
  const expiresSoon = expiryIsValid ? expiryMillis <= Date.now() + 30_000 : true;
  const needsRefresh =
    !credentials.accessToken || alreadyExpired || expiresSoon || accountRow.needs_reconnect;

  if (needsRefresh) {
    const refreshed = await refreshCalendarAccess({
      credentials,
      admin,
      clientId,
      clientSecret,
    });
    if (!refreshed) {
      await setCalendarReconnectFlag(admin, credentials.accountId, true);
      return null;
    }
    credentials.refreshed = true;
  }

  await setCalendarReconnectFlag(admin, credentials.accountId, false);
  return credentials;
}

async function refreshCalendarAccess(args: {
  credentials: CalendarClientCredentials;
  admin: SupabaseClient<Database, "public">;
  clientId: string;
  clientSecret: string;
}): Promise<boolean> {
  const { credentials, admin, clientId, clientSecret } = args;
  const refreshToken = credentials.refreshToken;
  if (!refreshToken) return false;

  const refreshed = await refreshGoogleToken(refreshToken, clientId, clientSecret);
  if (!refreshed || typeof refreshed.access_token !== "string") {
    return false;
  }

  const nextRefreshToken =
    typeof refreshed.refresh_token === "string" && refreshed.refresh_token.trim().length > 0
      ? refreshed.refresh_token
      : refreshToken;

  credentials.accessToken = refreshed.access_token;
  credentials.refreshToken = nextRefreshToken;
  credentials.refreshed = true;

  const expiresIn =
    typeof refreshed.expires_in === "number" && Number.isFinite(refreshed.expires_in) && refreshed.expires_in > 0
      ? refreshed.expires_in
      : 3600;

  await persistCalendarToken(admin, {
    accountId: credentials.accountId,
    accessToken: credentials.accessToken,
    refreshToken: nextRefreshToken,
    expiresInSeconds: expiresIn,
  });

  return true;
}

async function persistCalendarToken(
  admin: SupabaseClient<Database, "public">,
  params: { accountId: number; accessToken: string; refreshToken: string | null; expiresInSeconds: number },
) {
  const expiryIso = new Date(Date.now() + Math.max(0, params.expiresInSeconds) * 1000).toISOString();
  const calendarTokens = admin.from("calendar_tokens") as unknown as {
    upsert: (
      values: {
        account_id: number;
        access_token: string;
        refresh_token: string | null;
        expiry: string;
      },
    ) => Promise<unknown>;
  };

  await calendarTokens.upsert({
    account_id: params.accountId,
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    expiry: expiryIso,
  });

  return expiryIso;
}

async function refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  return await res.json();
}

async function setCalendarReconnectFlag(
  admin: SupabaseClient<Database, "public">,
  accountId: number,
  needsReconnect: boolean,
) {
  await admin.from("calendar_accounts").update({ needs_reconnect: needsReconnect }).eq("id", accountId);
}

