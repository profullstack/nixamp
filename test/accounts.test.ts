import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Accounts,
  type AuthLike,
  checkCredentials,
  PASSWORD_RULES,
  clearedCookie,
  readClaims,
  readResult,
  sessionCookie,
  tokenFrom,
} from "../src/accounts.ts";
import { parseLoginArgs } from "../src/session.ts";

const good = { user: { id: "u1", email: "a@b.com" }, tokens: { accessToken: "tok" } };

/** A stand-in that behaves the way the real module does, throws included. */
function fakeAuth(over: Partial<AuthLike> = {}): AuthLike {
  return {
    register: async () => good,
    login: async () => good,
    validateToken: async () => ({ userId: "u1", email: "a@b.com" }),
    ...over,
  };
}

const accounts = (over: Partial<AuthLike> = {}) =>
  new Accounts({ connectionString: "", secret: "", system: fakeAuth(over) });

test("an address has to look like one, and a password has to be long enough", () => {
  assert.equal(checkCredentials("a@b.com", "a-long-enough-one"), "");
  assert.match(checkCredentials("not-an-address", "a-long-enough-one"), /email address/);
  assert.match(checkCredentials("a@b", "a-long-enough-one"), /email address/);
  assert.match(checkCredentials("a@b.com", "short"), /8 characters/);
  assert.match(checkCredentials("a@b.com", "x".repeat(500)), /too long/);
  assert.match(checkCredentials(42, "a-long-enough-one"), /email address/);
  assert.match(checkCredentials("a@b.com", undefined), /8 characters/);

  // Eight is the floor, and the composition rules the module would otherwise
  // apply are off: eight digits are a password here. Both halves have to agree
  // about that, which is what PASSWORD_RULES is for -- a password this accepts
  // and the module refuses is a sign-up that fails with a different sentence.
  assert.equal(checkCredentials("a@b.com", "12341234"), "");
  assert.match(checkCredentials("a@b.com", "1234123"), /8 characters/);
  assert.equal(PASSWORD_RULES.minLength, 8);
  assert.equal(PASSWORD_RULES.requireUppercase, false);
  assert.equal(PASSWORD_RULES.requireLowercase, false);
});

test("a login result is read out of the module's shape", () => {
  const read = readResult(good);
  assert.equal(read.ok, true);
  assert.deepEqual(read.account, { id: "u1", email: "a@b.com" });
  assert.equal(read.token, "tok");

  // Anything without both an id and a token is a refusal, not a success.
  assert.equal(readResult({}).ok, false);
  assert.equal(readResult({ user: { id: "u1" } }).ok, false);
  assert.equal(readResult({ tokens: { accessToken: "t" } }).ok, false);
  assert.equal(readResult(null).ok, false);
});

test("validateToken answers claims directly, not the login shape", () => {
  // The two shapes differ in the module, which is the trap this covers.
  assert.deepEqual(readClaims({ userId: "u1", email: "a@b.com" }), { id: "u1", email: "a@b.com" });
  assert.equal(readClaims({ user: { id: "u1" } }), null);
  assert.equal(readClaims({}), null);
  assert.equal(readClaims(null), null);
});

test("login() throwing is the ordinary path, not a crash", async () => {
  // The module throws `Invalid email or password` rather than resolving
  // success: false, so a bare `if (!result.success)` never runs.
  const refusing = accounts({
    login: async () => {
      throw new Error("Invalid email or password");
    },
  });
  const result = await refusing.signIn("a@b.com", "a-long-enough-one");
  assert.equal(result.ok, false);
  assert.equal(result.account, null);
  assert.match(result.error, /do not match an account/);
});

test("a wrong password and an unknown address get the same sentence", async () => {
  const refusing = accounts({
    login: async () => {
      throw new Error("Invalid email or password");
    },
  });
  const wrongPassword = await refusing.signIn("known@b.com", "a-long-enough-one");
  const unknownAddress = await refusing.signIn("nobody@b.com", "a-long-enough-one");
  // Saying which is how an endpoint tells a stranger who has registered.
  assert.equal(wrongPassword.error, unknownAddress.error);

  // A malformed address gets it too, rather than a different message that
  // would separate "no such account" from "not even an address".
  const malformed = await refusing.signIn("nope", "a-long-enough-one");
  assert.equal(malformed.error, wrongPassword.error);
});

test("a taken address is named, because a sign-up form has to say why", async () => {
  const taken = accounts({
    register: async () => {
      throw new Error("User already exists");
    },
  });
  const result = await taken.signUp("a@b.com", "a-long-enough-one");
  assert.equal(result.ok, false);
  // It reveals nothing that trying to sign up does not reveal anyway.
  assert.match(result.error, /already an account/);
});

test("a sign-up that fails for another reason does not blame the address", async () => {
  const broken = accounts({
    register: async () => {
      throw new Error("connection refused");
    },
  });
  const result = await broken.signUp("a@b.com", "a-long-enough-one");
  assert.match(result.error, /could not create/);
  assert.doesNotMatch(result.error, /already/);
});

test("signing up validates before it asks the database anything", async () => {
  let asked = false;
  const watching = accounts({
    register: async () => {
      asked = true;
      return good;
    },
  });
  const result = await watching.signUp("a@b.com", "short");
  assert.equal(result.ok, false);
  assert.equal(asked, false);
});

test("a token that does not validate is nobody", async () => {
  const bad = accounts({
    validateToken: async () => {
      throw new Error("jwt expired");
    },
  });
  assert.equal(await bad.whoIs("stale"), null);
  assert.equal(await accounts().whoIs(""), null);
  assert.deepEqual(await accounts().whoIs("good"), { id: "u1", email: "a@b.com" });
});

test("the token is found in a header or the session cookie", () => {
  assert.equal(tokenFrom({ authorization: "Bearer abc123" }), "abc123");
  assert.equal(tokenFrom({ authorization: "bearer abc123" }), "abc123");
  assert.equal(tokenFrom({ cookie: "nixamp_session=abc123" }), "abc123");
  assert.equal(tokenFrom({ cookie: "other=x; nixamp_session=abc123; more=y" }), "abc123");
  // The header wins, so a CLI token is not shadowed by a stale browser cookie.
  assert.equal(tokenFrom({ authorization: "Bearer header", cookie: "nixamp_session=cookie" }), "header");
  assert.equal(tokenFrom({}), "");
  assert.equal(tokenFrom({ authorization: "Basic abc" }), "");
});

test("the session cookie is HttpOnly, and Secure only where https is", () => {
  const plain = sessionCookie("abc", false);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  // A nixamp on your own network is plain http; Secure would drop the cookie.
  assert.doesNotMatch(plain, /Secure/);
  assert.match(sessionCookie("abc", true), /Secure/);
  assert.match(clearedCookie(), /Max-Age=0/);
});

test("login flags: a site, an address, and which of the two things it is", () => {
  const bare = parseLoginArgs([]);
  assert.equal(bare.site, "https://nixamp.com");
  assert.equal(bare.signUp, false);

  const full = parseLoginArgs(["--site", "http://localhost:4321/", "--email", "a@b.com", "--signup"]);
  assert.equal(full.site, "http://localhost:4321");
  assert.equal(full.email, "a@b.com");
  assert.equal(full.signUp, true);

  // An address given as a bare argument is still an address.
  assert.equal(parseLoginArgs(["a@b.com"]).email, "a@b.com");
  assert.equal(parseLoginArgs(["--sign-up"]).signUp, true);
});
