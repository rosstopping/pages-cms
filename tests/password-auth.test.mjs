import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { passwordAuthOptions } from "../lib/password-auth.ts";

async function fixture() {
  const store = { user: [], account: [], session: [], verification: [] };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-only-at-least-thirty-two-characters",
    database: memoryAdapter(store),
    emailAndPassword: passwordAuthOptions,
    logger: { level: "error" },
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({
    name: "Collaborator", email: "collaborator@example.com", emailVerified: false,
  });
  const password = "a-long-test-password";
  const credential = await context.internalAdapter.createAccount({
    userId: user.id, accountId: user.id, providerId: "credential",
    password: await context.password.hash(password),
  });
  return { auth, context, user, credential, password, store };
}

test("administrator-provisioned credentials sign in without claiming verified email", async () => {
  const { auth, user, credential, password } = await fixture();
  assert.notEqual(credential.password, password);
  const result = await auth.api.signInEmail({ body: { email: user.email, password } });
  assert.equal(result.user.id, user.id);
  assert.equal(result.user.emailVerified, false);
  assert.ok(result.token);
});

test("incorrect passwords and unknown accounts are rejected", async () => {
  const { auth, user, password } = await fixture();
  for (const body of [
    { email: user.email, password: "wrong-test-password" },
    { email: "unknown@example.com", password },
  ]) {
    await assert.rejects(auth.api.signInEmail({ body }), error => error.status === "UNAUTHORIZED");
  }
});

test("public email/password registration is disabled", async () => {
  const { auth, store, password } = await fixture();
  await assert.rejects(auth.api.signUpEmail({
    body: { name: "Uninvited", email: "uninvited@example.com", password },
  }));
  assert.equal(store.user.length, 1);
});

test("replaced credentials reject the old password and revoked sessions stop working", async () => {
  const { auth, context, user, credential, password } = await fixture();
  const response = await auth.api.signInEmail({
    body: { email: user.email, password }, asResponse: true,
  });
  const signedIn = await response.json();
  const headers = new Headers({ cookie: response.headers.get("set-cookie").split(";")[0] });
  assert.equal((await auth.api.getSession({ headers })).user.id, user.id);
  assert.ok(await context.internalAdapter.findSession(signedIn.token));
  const replacement = "replacement-test-password";
  await context.internalAdapter.updateAccount(credential.id, {
    password: await context.password.hash(replacement),
  });
  await context.internalAdapter.deleteSessions(user.id);
  assert.equal(await context.internalAdapter.findSession(signedIn.token), null);
  assert.equal(await auth.api.getSession({ headers }), null);
  await assert.rejects(auth.api.signInEmail({ body: { email: user.email, password } }));
  assert.ok((await auth.api.signInEmail({ body: { email: user.email, password: replacement } })).token);
});
