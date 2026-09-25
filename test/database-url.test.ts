import { test } from "node:test";
import assert from "node:assert/strict";
import { libpqDatabaseUrl } from "../src/server.ts";

// pg reads `sslmode=require` as verify-full unless the URL says otherwise; a
// self-signed cluster then refuses every query. The libpq reading is asked for
// in the URL itself, so the Accounts adapter (which only takes a string) gets it too.
test("a URL with an sslmode asks pg for libpq semantics", () => {
  assert.equal(
    libpqDatabaseUrl("postgres://u:p@db.example:5432/app?sslmode=require"),
    "postgres://u:p@db.example:5432/app?sslmode=require&uselibpqcompat=true",
  );
});

test("a URL without an sslmode is left alone", () => {
  const plain = "postgresql://u:p@postgres.railway.internal:5432/railway";
  assert.equal(libpqDatabaseUrl(plain), plain);
});

test("a URL that already says how to read it is left alone", () => {
  const explicit = "postgres://u:p@db.example/app?uselibpqcompat=true&sslmode=require";
  assert.equal(libpqDatabaseUrl(explicit), explicit);
  const noVerify = "postgres://u:p@db.example/app?sslmode=no-verify";
  assert.equal(libpqDatabaseUrl(noVerify), noVerify);
  const full = "postgres://u:p@db.example/app?sslmode=verify-full";
  assert.equal(libpqDatabaseUrl(full), full);
});

test("no URL stays no URL", () => {
  assert.equal(libpqDatabaseUrl(undefined), undefined);
  assert.equal(libpqDatabaseUrl(""), "");
});
