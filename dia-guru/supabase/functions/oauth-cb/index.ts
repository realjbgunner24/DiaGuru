import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VERSION = "cb-v1";

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // Supabase access token from the app

    // When opened with no params, show HTML (NO auth header required)
    if (!code || !state) {
      const html = `<!doctype html>
        <meta charset="utf-8">
        <title>Callback alive</title>
        <h1>Callback alive (${VERSION})</h1>
        <p>code present: ${!!code}</p>
        <p>state present: ${!!state}</p>`;
      return new Response(html, { status: 400, headers: { "Content-Type": "text/html" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRole = Deno.env.get("SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI")!;

    // 0. Verify user using the JWT we passed in `state`
    const supaAnon = createClient(supabaseUrl, anon);
    const { data: { user } } = await supaAnon.auth.getUser(state);
    if (!user) return new Response("Unauthorized state", { status: 401 });

    // Exchange code for tokens
    const form = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const tok = await r.json();
    if (!r.ok) return new Response("Google token exchange failed", { status: 502 });

    // Store tokens (server-side only)
    const admin = createClient(supabaseUrl, serviceRole);
    const { data: acct } = await admin
      .from("calendar_accounts")
      .upsert({ user_id: user.id, provider: "google" })
      .select("id")
      .single();

    const expiry = new Date(Date.now() + (tok.expires_in ?? 0) * 1000).toISOString();
    await admin.from("calendar_tokens").upsert({
      account_id: acct!.id,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      expiry,
    });

    const ok = `<!doctype html>
      <meta charset="utf-8">
      <title>Connected</title>
      <h1>Google Calendar connected!</h1>
      <p>Version: ${VERSION}</p>`;
    return new Response(ok, { status: 200, headers: { "Content-Type": "text/html" } });
  } catch {
    return new Response("OAuth error", { status: 500 });
  }
});
