import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStrictEquals,
} from "std/assert";

import { getCalendarHealth } from "../calendar-health/index.ts";
import type { CalendarAccountRow, CalendarTokenRow, Database } from "../types.ts";
import {
  ScheduleError,
  resolveCalendarClient,
  __test__ as scheduleTestUtils,
} from "./index.ts";

import type { SupabaseClient } from "@supabase/supabase-js";

const { createGoogleCalendarActions } = scheduleTestUtils;

type AdminStubState = {
  account: CalendarAccountRow | null;
  token: CalendarTokenRow | null;
};

type AdminStubLogs = {
  accountUpdates: Array<Record<string, unknown>>;
  tokenUpserts: Array<Record<string, unknown>>;
};

type AdminStub = {
  client: SupabaseClient<Database, "public">;
  state: AdminStubState;
  logs: AdminStubLogs;
};

function createAdminStub(initial: {
  account?: CalendarAccountRow | null;
  token?: CalendarTokenRow | null;
}): AdminStub {
  const state: AdminStubState = {
    account: initial.account ?? null,
    token: initial.token ?? null,
  };
  const logs: AdminStubLogs = {
    accountUpdates: [],
    tokenUpserts: [],
  };

  const client = {
    from(table: string) {
      if (table === "calendar_accounts") {
        return {
          select() {
            const query = {
              eq() {
                return query;
              },
              single: async () => ({ data: state.account, error: null }),
              maybeSingle: async () => ({ data: state.account, error: null }),
            };
            return query;
          },
          update(values: Record<string, unknown>) {
            return {
              eq: async () => {
                if (state.account) {
                  state.account = { ...state.account, ...values } as CalendarAccountRow;
                } else {
                  state.account = {
                    id: 1,
                    user_id: "stub-user",
                    provider: "google",
                    needs_reconnect: Boolean(values.needs_reconnect),
                  };
                }
                logs.accountUpdates.push(values);
                return { data: state.account ? [state.account] : [], error: null };
              },
            };
          },
        };
      }

      if (table === "calendar_tokens") {
        return {
          select() {
            const query = {
              eq() {
                return query;
              },
              single: async () => ({ data: state.token, error: null }),
              maybeSingle: async () => ({ data: state.token, error: null }),
            };
            return query;
          },
          upsert: async (values: {
            account_id: number;
            access_token: string;
            refresh_token: string | null;
            expiry: string;
          }) => {
            state.token = {
              account_id: values.account_id,
              access_token: values.access_token,
              refresh_token: values.refresh_token,
              expiry: values.expiry,
            };
            logs.tokenUpserts.push(values);
            return { data: state.token, error: null };
          },
        };
      }

      throw new Error(`Unsupported table ${table}`);
    },
  };

  return {
    client: client as SupabaseClient<Database, "public">,
    state,
    logs,
  };
}

function stubFetch(factory: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    return await factory(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("resolveCalendarClient refreshes expiring access tokens", async () => {
  const account: CalendarAccountRow = {
    id: 42,
    user_id: "user-1",
    provider: "google",
    needs_reconnect: false,
  };
  const token: CalendarTokenRow = {
    account_id: 42,
    access_token: "old-token",
    refresh_token: "refresh-token",
    expiry: new Date(Date.now() + 10_000).toISOString(),
  };

  const admin = createAdminStub({ account, token });

  const restore = stubFetch(async (url) => {
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  try {
    const credentials = await resolveCalendarClient(admin.client, "user-1", "client", "secret");
    assert(credentials);
    assertEquals(credentials.accessToken, "new-token");
    assertEquals(credentials.refreshToken, "new-refresh");
    assertStrictEquals(credentials.refreshed, true);
    assertEquals(admin.state.token?.access_token, "new-token");
    assertEquals(admin.state.account?.needs_reconnect, false);
    assertEquals(admin.logs.tokenUpserts.length, 1);
  } finally {
    restore();
  }
});

Deno.test("resolveCalendarClient flags account when tokens missing", async () => {
  const account: CalendarAccountRow = {
    id: 7,
    user_id: "user-1",
    provider: "google",
    needs_reconnect: false,
  };
  const admin = createAdminStub({ account, token: null });

  const restore = stubFetch(async () => {
    throw new Error("fetch should not be called");
  });

  try {
    const credentials = await resolveCalendarClient(admin.client, "user-1", "client", "secret");
    assertStrictEquals(credentials, null);
    assert(admin.state.account?.needs_reconnect);
  } finally {
    restore();
  }
});

Deno.test("createGoogleCalendarActions retries once after 401 and refreshes token", async () => {
  const account: CalendarAccountRow = {
    id: 99,
    user_id: "user-2",
    provider: "google",
    needs_reconnect: false,
  };
  const token: CalendarTokenRow = {
    account_id: 99,
    access_token: "expired-token",
    refresh_token: "refresh-token",
    expiry: new Date(Date.now() + 3600_000).toISOString(),
  };
  const admin = createAdminStub({ account, token });

  let eventCalls = 0;
  const restore = stubFetch(async (url) => {
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
      eventCalls += 1;
      if (eventCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "fresh-token", expires_in: 7200 }), { status: 200 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  try {
    const google = createGoogleCalendarActions({
      credentials: {
        accountId: 99,
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        refreshed: false,
      },
      admin: admin.client,
      clientId: "client",
      clientSecret: "secret",
    });

    const events = await google.listEvents(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    assert(Array.isArray(events));
    assertEquals(eventCalls, 2);
    assertEquals(admin.state.token?.access_token, "fresh-token");
    assertEquals(admin.state.account?.needs_reconnect, false);
  } finally {
    restore();
  }
});

Deno.test("createGoogleCalendarActions marks reconnect when refresh fails", async () => {
  const account: CalendarAccountRow = {
    id: 5,
    user_id: "user-3",
    provider: "google",
    needs_reconnect: false,
  };
  const token: CalendarTokenRow = {
    account_id: 5,
    access_token: "expired-token",
    refresh_token: "refresh-token",
    expiry: new Date(Date.now() + 3600_000).toISOString(),
  };
  const admin = createAdminStub({ account, token });

  const restore = stubFetch(async (url) => {
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
      return new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 });
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  try {
    const google = createGoogleCalendarActions({
      credentials: {
        accountId: 5,
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        refreshed: false,
      },
      admin: admin.client,
      clientId: "client",
      clientSecret: "secret",
    });

    await assertRejects(
      () => google.listEvents(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()),
      ScheduleError,
      "Google Calendar not linked",
    );
    assert(admin.state.account?.needs_reconnect);
  } finally {
    restore();
  }
});

Deno.test("getCalendarHealth returns healthy when tokens are valid", async () => {
  const account: CalendarAccountRow = {
    id: 10,
    user_id: "user-healthy",
    provider: "google",
    needs_reconnect: false,
  };
  const token: CalendarTokenRow = {
    account_id: 10,
    access_token: "valid-token",
    refresh_token: "refresh-token",
    expiry: new Date(Date.now() + 7200_000).toISOString(),
  };
  const admin = createAdminStub({ account, token });

  const restore = stubFetch(async () => {
    throw new Error("fetch should not be invoked for valid tokens");
  });

  try {
    const health = await getCalendarHealth({
      admin: admin.client,
      userId: "user-healthy",
      clientId: "client",
      clientSecret: "secret",
    });

    assertEquals(health.status, "healthy");
    assertFalse(health.needsReconnect);
    assertFalse(health.refreshed);
    assertEquals(health.linked, true);
  } finally {
    restore();
  }
});

Deno.test("getCalendarHealth signals reconnect when refresh fails", async () => {
  const account: CalendarAccountRow = {
    id: 12,
    user_id: "user-expired",
    provider: "google",
    needs_reconnect: false,
  };
  const token: CalendarTokenRow = {
    account_id: 12,
    access_token: "stale-token",
    refresh_token: "refresh-token",
    expiry: new Date(Date.now() - 60_000).toISOString(),
  };
  const admin = createAdminStub({ account, token });

  const restore = stubFetch(async (url) => {
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  try {
    const health = await getCalendarHealth({
      admin: admin.client,
      userId: "user-expired",
      clientId: "client",
      clientSecret: "secret",
    });

    assertEquals(health.status, "needs_reconnect");
    assert(health.needsReconnect);
    assertFalse(health.refreshed);
    assert(admin.state.account?.needs_reconnect);
  } finally {
    restore();
  }
});
