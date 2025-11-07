import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { resolveCalendarClient } from "../_shared/calendar-client.ts";
import type { CalendarAccountRow, Database } from "../types.ts";

type HealthStatus = "unlinked" | "healthy" | "needs_reconnect";

export type HealthResponse = {
  status: HealthStatus;
  linked: boolean;
  needsReconnect: boolean;
  hasRefreshToken: boolean;
  expiresAt: string | null;
  expiresInSeconds: number | null;
  refreshed: boolean;
  checkedAt: string;
};

export async function getCalendarHealth(args: {
  admin: SupabaseClient<Database, "public">;
  userId: string;
  clientId: string;
  clientSecret: string;
}): Promise<HealthResponse> {
  const { admin, userId, clientId, clientSecret } = args;

  const { data: accountRow, error: accountError } = await admin
    .from("calendar_accounts")
    .select("id, needs_reconnect")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  if (accountError) {
    throw new Error(accountError.message);
  }

  if (!accountRow) {
    const now = new Date().toISOString();
    return {
      status: "unlinked",
      linked: false,
      needsReconnect: false,
      hasRefreshToken: false,
      expiresAt: null,
      expiresInSeconds: null,
      refreshed: false,
      checkedAt: now,
    };
  }

  const account = accountRow as CalendarAccountRow;

  const resolved = await resolveCalendarClient(admin, userId, clientId, clientSecret);

  const { data: latestAccount, error: latestAccountError } = await admin
    .from("calendar_accounts")
    .select("needs_reconnect")
    .eq("id", account.id)
    .maybeSingle();

  if (latestAccountError) {
    throw new Error(latestAccountError.message);
  }

  const { data: tokenRow, error: tokenError } = await admin
    .from("calendar_tokens")
    .select("expiry, refresh_token")
    .eq("account_id", account.id)
    .maybeSingle();

  if (tokenError) {
    throw new Error(tokenError.message);
  }

  const needsReconnectFlag = latestAccount?.needs_reconnect ?? account.needs_reconnect ?? false;
  const expiresAt = tokenRow?.expiry ?? null;
  const hasRefreshToken = Boolean(tokenRow?.refresh_token);

  let expiresInSeconds: number | null = null;
  if (expiresAt) {
    const ms = Date.parse(expiresAt) - Date.now();
    expiresInSeconds = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  const refreshedFlag = Boolean(resolved?.refreshed);
  const needsReconnect = needsReconnectFlag || !tokenRow;
  const status: HealthStatus = needsReconnect ? "needs_reconnect" : "healthy";

  const checkedAt = new Date().toISOString();
  return {
    status,
    linked: true,
    needsReconnect,
    hasRefreshToken,
    expiresAt,
    expiresInSeconds,
    refreshed: refreshedFlag && !needsReconnect,
    checkedAt,
  };
}

export async function handler(req: Request) {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRole = Deno.env.get("SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const supaFromUser = createClient<Database>(supabaseUrl, anon, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userError } = await supaFromUser.auth.getUser();
    if (userError || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const admin = createClient<Database, "public">(supabaseUrl, serviceRole);
    const payload = await getCalendarHealth({
      admin,
      userId: userData.user.id,
      clientId,
      clientSecret,
    });
    return json(payload);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return json({ error: "Health check failed", details }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
