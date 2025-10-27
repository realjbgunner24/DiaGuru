import { createClient } from "@supabase/supabase-js";

type GEvent = {
  id: string;
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
};

const GOOGLE_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Why this shape?
 * - We read the user id from the Authorization header (JWT) -> secure.
 * - We read tokens from DB with the service role -> avoids RLS headaches for server-side jobs.
 * - If access_token is expired, we refresh (if refresh_token exists), save, and continue.
 * - We return a small, UI-friendly array.
 */
Deno.serve(async (req) => {
  try {
    // 0) Identify user from Supabase JWT in the Authorization header
    const auth = req.headers.get("Authorization"); // "Bearer <jwt>"
    if (!auth) return json({ error: "Missing Authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRole = Deno.env.get("SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const supaFromUser = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user }, error: uerr } = await supaFromUser.auth.getUser();
    if (uerr || !user) return json({ error: "Unauthorized" }, 401);

    // 1) Load Google tokens for this user
    const admin = createClient(supabaseUrl, serviceRole);
    const { data: acct, error: aerr } = await admin
      .from("calendar_accounts")
      .select("id")
      .eq("user_id", user.id)
      .eq("provider", "google")
      .single();
    if (aerr || !acct) return json({ error: "No Google account linked" }, 404);

    const { data: tok, error: terr } = await admin
      .from("calendar_tokens")
      .select("access_token, refresh_token, expiry")
      .eq("account_id", acct.id)
      .single();
    if (terr || !tok) return json({ error: "No tokens found" }, 404);

    let accessToken = tok.access_token;
    const refreshToken = tok.refresh_token as string | null;
    const isExpired = tok.expiry ? Date.parse(tok.expiry) <= Date.now() + 30_000 : true; // refresh if within 30s

    // 2) Refresh token if needed
    if (isExpired && refreshToken) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      const rr = await fetch(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const rj = await rr.json();
      if (!rr.ok) return json({ error: "Failed to refresh Google token", details: rj }, 401);

      accessToken = rj.access_token;
      const newExpiry = new Date(Date.now() + (rj.expires_in ?? 0) * 1000).toISOString();
      await admin.from("calendar_tokens").upsert({
        account_id: acct.id,
        access_token: accessToken,
        refresh_token: refreshToken, // Google sometimes omits it on refresh -> keep old one
        expiry: newExpiry,
      });
    }

    // 3) Time window (default next 7 days)
    const { rangeDays = 7 } = await safeJson(req);
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + rangeDays * 86400000).toISOString();

    // 4) Fetch events
    const url = new URL(GOOGLE_EVENTS);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("maxResults", "50");

    const gr = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const gj = await gr.json();
    if (!gr.ok) return json({ error: "Google API error", details: gj }, 502);

    const rawItems = Array.isArray(gj.items) ? (gj.items as unknown[]) : [];
    const items: GEvent[] = rawItems.map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        id: String(record.id ?? ""),
        summary: record.summary as string | undefined,
        htmlLink: record.htmlLink as string | undefined,
        start: record.start as GEvent["start"],
        end: record.end as GEvent["end"],
        extendedProperties: record.extendedProperties as GEvent["extendedProperties"],
      };
    });

    return json({ items, timeMin, timeMax });
  } catch (e) {
    return json({ error: "Server error", details: String(e) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function safeJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
