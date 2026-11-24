"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_TTL_MS,
  getEmbeddedSignupConfig,
  createSignupSession,
  claimSignupSession,
  finishSignupSession,
  completeEmbeddedSignup,
  generateRegistrationPin
} = require("../src/embeddedSignup");

function fakeDb() {
  const records = new Map();
  function doc(path) {
    return {
      path,
      async create(value) {
        if (records.has(path)) throw new Error("already exists");
        records.set(path, value);
      },
      async set(value, options = {}) {
        records.set(path, options.merge ? { ...(records.get(path) || {}), ...value } : value);
      },
      async get() {
        const value = records.get(path);
        return { exists: Boolean(value), data: () => value };
      },
      collection(name) { return collection(path + "/" + name); }
    };
  }
  function collection(path) {
    return { doc(id) { return doc(path + "/" + id); } };
  }
  return {
    records,
    collection,
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = records.get(ref.path);
          return { exists: Boolean(value), data: () => value };
        },
        set(ref, value, options = {}) {
          writes.push(() => records.set(ref.path, options.merge ? { ...(records.get(ref.path) || {}), ...value } : value));
        }
      };
      const result = await callback(transaction);
      for (const write of writes) write();
      return result;
    }
  };
}

const env = {
  META_APP_ID: "123456789012345",
  META_APP_SECRET: "test-app-secret",
  META_EMBEDDED_SIGNUP_CONFIG_ID: "987654321098765",
  GRAPH_API_VERSION: "v26.0"
};

test("Embedded Signup config is public-only and unavailable until app/config IDs exist", () => {
  assert.deepEqual(getEmbeddedSignupConfig(env), {
    appId: env.META_APP_ID,
    configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID,
    graphApiVersion: "v26.0",
    partnerMode: "tech_provider",
    solutionId: null
  });
  assert.equal(getEmbeddedSignupConfig({ META_APP_ID: env.META_APP_ID }), null);
  assert.equal(getEmbeddedSignupConfig({ ...env, META_APP_ID: "not-an-id" }), null);
  assert.equal(getEmbeddedSignupConfig({ ...env, META_APP_SECRET: "" }), null);
});



test("Solution Partner mode requires its system user and credit-line configuration", () => {
  const partnerEnv = {
    ...env,
    META_PARTNER_MODE: "solution_partner",
    META_EMBEDDED_SIGNUP_SOLUTION_ID: "999999999999999",
    META_SYSTEM_USER_ID: "777777777777777",
    META_SYSTEM_USER_ACCESS_TOKEN: "EAA" + "s".repeat(40),
    META_EXTENDED_CREDIT_LINE_ID: "888888888888888",
    META_CREDIT_LINE_CURRENCY: "INR"
  };
  assert.equal(getEmbeddedSignupConfig(partnerEnv).partnerMode, "solution_partner");
  assert.equal(getEmbeddedSignupConfig({ ...partnerEnv, META_SYSTEM_USER_ACCESS_TOKEN: "" }), null);
});

test("signup session is bound to a workspace and user, expires and can only be claimed once", async () => {
  const db = fakeDb();
  const now = Date.parse("2026-11-24T10:00:00Z");
  const session = await createSignupSession(db, "org_one", "user_one", now);
  assert.equal(Date.parse(session.expiresAt), now + SESSION_TTL_MS);
  const claimed = await claimSignupSession(db, "org_one", "user_one", session.sessionId, now + 1);
  await finishSignupSession(claimed.ref, "completed");
  await assert.rejects(
    () => claimSignupSession(db, "org_one", "user_one", session.sessionId, now + 2),
    { statusCode: 409 }
  );
  await assert.rejects(
    () => claimSignupSession(db, "org_two", "user_one", session.sessionId, now + 2),
    { statusCode: 400 }
  );
});

test("signup session cannot be claimed by a different user", async () => {
  const db = fakeDb();
  const session = await createSignupSession(db, "org_one", "owner");
  await assert.rejects(
    () => claimSignupSession(db, "org_one", "attacker", session.sessionId),
    { statusCode: 403 }
  );
});

test("expired signup sessions are rejected", async () => {
  const db = fakeDb();
  const now = Date.now();
  const session = await createSignupSession(db, "org_one", "owner", now - SESSION_TTL_MS - 10);
  await assert.rejects(
    () => claimSignupSession(db, "org_one", "owner", session.sessionId, now),
    { statusCode: 410 }
  );
});

test("Embedded Signup exchanges code, validates selected WABA/phone, registers phone and subscribes app", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname.endsWith("/oauth/access_token")) {
      assert.equal(parsed.searchParams.get("client_secret"), env.META_APP_SECRET);
      assert.equal(parsed.searchParams.get("code"), "valid-authorization-code");
      return { ok: true, async json() { return { access_token: "EAA" + "x".repeat(40) }; } };
    }
    if (parsed.pathname.endsWith("/123456789012345")) {
      return { ok: true, async json() { return { id: "123456789012345", display_phone_number: "+91 98765 43210", verified_name: "Example Business" }; } };
    }
    if (parsed.pathname.endsWith("/111111111111111/phone_numbers")) {
      return { ok: true, async json() { return { data: [{ id: "123456789012345" }] }; } };
    }
    if (parsed.pathname.endsWith("/123456789012345/register")) {
      assert.equal(options.method, "POST");
      assert.equal(JSON.parse(options.body).pin, "123456");
      return { ok: true, async json() { return { success: true }; } };
    }
    if (parsed.pathname.endsWith("/111111111111111/subscribed_apps")) {
      assert.equal(options.method, "POST");
      return { ok: true, async json() { return { success: true }; } };
    }
    throw new Error("Unexpected Meta endpoint: " + parsed.pathname);
  };

  const result = await completeEmbeddedSignup({
    code: "valid-authorization-code",
    wabaId: "111111111111111",
    phoneNumberId: "123456789012345",
    registrationPin: "123456",
    env,
    fetchImpl
  });
  assert.equal(result.wabaId, "111111111111111");
  assert.equal(result.phoneNumberId, "123456789012345");
  assert.equal(result.displayPhoneNumber, "+91 98765 43210");
  assert.equal(result.verifiedName, "Example Business");
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.url.hostname === "graph.facebook.com"));
  assert.equal(calls[3].url.pathname.endsWith("/111111111111111/subscribed_apps"), true);
  assert.equal(calls[4].url.pathname.endsWith("/123456789012345/register"), true);
  assert.equal(calls[4].options.headers.Authorization, "Bearer " + "EAA" + "x".repeat(40));
});

test("Solution Partner onboarding assigns its system user and shares its credit line before registration", async () => {
  const partnerEnv = {
    ...env,
    META_PARTNER_MODE: "solution_partner",
    META_EMBEDDED_SIGNUP_SOLUTION_ID: "999999999999999",
    META_SYSTEM_USER_ID: "777777777777777",
    META_SYSTEM_USER_ACCESS_TOKEN: "EAA" + "s".repeat(40),
    META_EXTENDED_CREDIT_LINE_ID: "888888888888888",
    META_CREDIT_LINE_CURRENCY: "INR"
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    if (parsed.pathname.endsWith("/oauth/access_token")) return { ok: true, async json() { return { access_token: "EAA" + "x".repeat(40) }; } };
    if (parsed.pathname.endsWith("/123456789012345")) return { ok: true, async json() { return { id: "123456789012345" }; } };
    if (parsed.pathname.endsWith("/111111111111111/phone_numbers")) return { ok: true, async json() { return { data: [{ id: "123456789012345" }] }; } };
    if (parsed.pathname.endsWith("/111111111111111/assigned_users")) {
      assert.equal(parsed.searchParams.get("user"), partnerEnv.META_SYSTEM_USER_ID);
      assert.deepEqual(JSON.parse(parsed.searchParams.get("tasks")), ["MANAGE", "DEVELOP"]);
      assert.equal(options.headers.Authorization, "Bearer " + partnerEnv.META_SYSTEM_USER_ACCESS_TOKEN);
      return { ok: true, async json() { return { success: true }; } };
    }
    if (parsed.pathname.endsWith("/888888888888888/whatsapp_credit_sharing_and_attach")) {
      assert.equal(parsed.searchParams.get("waba_id"), "111111111111111");
      assert.equal(parsed.searchParams.get("waba_currency"), "INR");
      assert.equal(options.headers.Authorization, "Bearer " + partnerEnv.META_SYSTEM_USER_ACCESS_TOKEN);
      return { ok: true, async json() { return { success: true }; } };
    }
    if (parsed.pathname.endsWith("/111111111111111/subscribed_apps")) return { ok: true, async json() { return { success: true }; } };
    if (parsed.pathname.endsWith("/123456789012345/register")) return { ok: true, async json() { return { success: true }; } };
    throw new Error("Unexpected Meta endpoint: " + parsed.pathname);
  };
  const result = await completeEmbeddedSignup({
    code: "valid-authorization-code",
    wabaId: "111111111111111",
    phoneNumberId: "123456789012345",
    registrationPin: "123456",
    env: partnerEnv,
    fetchImpl
  });
  assert.equal(result.billingModel, "joy_inbox_partner_credit_line");
  assert.equal(calls.length, 7);
  assert.ok(calls[3].parsed.pathname.endsWith("/assigned_users"));
  assert.ok(calls[4].parsed.pathname.endsWith("/whatsapp_credit_sharing_and_attach"));
  assert.ok(calls[5].parsed.pathname.endsWith("/subscribed_apps"));
  assert.ok(calls[6].parsed.pathname.endsWith("/register"));
});

test("Embedded Signup refuses a phone number that is not part of the selected WABA", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/oauth/access_token")) return { ok: true, async json() { return { access_token: "EAA" + "x".repeat(40) }; } };
    if (parsed.pathname.endsWith("/123456789012345")) return { ok: true, async json() { return { id: "123456789012345" }; } };
    return { ok: true, async json() { return { data: [{ id: "999999999999999" }] }; } };
  };
  await assert.rejects(
    () => completeEmbeddedSignup({
      code: "valid-authorization-code",
      wabaId: "111111111111111",
      phoneNumberId: "123456789012345",
      registrationPin: "123456",
      env,
      fetchImpl
    }),
    { statusCode: 403 }
  );
});

test("registration PIN is always six digits", () => {
  for (let index = 0; index < 100; index += 1) assert.match(generateRegistrationPin(), /^\d{6}$/);
});
