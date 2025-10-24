import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // we'll send the Supabase access token here
    if (!code || !state) return new Response("Missing code/state", { status: 400 });

    // 1) Verify 'state' as a Supabase access token and get the user
    const supaAnon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${state}` } } }
    );
    const { data: { user } } = await supaAnon.auth.getUser();
    if (!user) return new Response("Unauthorized state", { status: 401 });

    // 2) Exchange code -> tokens with Google (server holds client secret)
    const body = new URLSearchParams({
      code,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      redirect_uri: Deno.env.get("GOOGLE_REDIRECT_URI")!, // must match exactly
      grant_type: "authorization_code",
    });
    const r = await fetch(TOKEN_URL, { method: "POST", body });
    const tok = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(tok));

    // 3) Store tokens using service role (server-side only)
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: acct, error: acctErr } = await admin
      .from("calendar_accounts")
      .upsert({ user_id: user.id, provider: "google" })
      .select("id")
      .single();
    if (acctErr) throw acctErr;

    const expiry = new Date(Date.now() + (tok.expires_in ?? 0)*1000).toISOString();
    await admin.from("calendar_tokens").upsert({
      account_id: acct.id,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null, // requires access_type=offline & prompt=consent
      expiry,
    });

    return new Response("Google Calendar connected. You can close this.", { status: 200 });
  } catch (e) {
    return new Response("OAuth error: " + (e as Error).message, { status: 500 });
  }
});
