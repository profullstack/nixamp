import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { MemoryAdapter } from "@profullstack/auth-system";
import { Accounts, type AdapterLike } from "../src/accounts.ts";

// Until 2026-10-09 the secret was passed as `jwtSecret`, which the module does
// not read, so every JWT was signed with its public default and anyone could
// mint a session for any account. These pin the secret to where it is read.

test("JWTs are signed with NIXAMP_JWT_SECRET, and one forged with the module default is refused", async () => {
  const accounts = new Accounts({ connectionString: "", secret: "the-real-secret-48-characters-long-xxxxxxxxxxxxxx", adapter: new MemoryAdapter() as unknown as AdapterLike });
  const system = (accounts as unknown as { system: { register: (o: object) => Promise<unknown>; login: (o: object) => Promise<{ tokens: { accessToken: string }; user: { id: string } }>; validateToken: (t: string) => Promise<unknown> } }).system;
  await system.register({ email: "jwt@example.com", password: "Password-123", autoVerify: true });
  const { tokens, user } = await system.login({ email: "jwt@example.com", password: "Password-123" });

  assert.ok(await system.validateToken(tokens.accessToken), "a real session validates");
  assert.equal(jwt.verify(tokens.accessToken, "the-real-secret-48-characters-long-xxxxxxxxxxxxxx") !== null, true);
  assert.throws(() => jwt.verify(tokens.accessToken, "default-secret-change-me"), "not signed with the public default");

  const forged = jwt.sign({ userId: user.id, type: "access" }, "default-secret-change-me", { expiresIn: 3600 });
  assert.equal(await system.validateToken(forged), null, "a token forged with the public default is refused");
});

test("accounts refuse to start without a secret", () => {
  assert.throws(() => new Accounts({ connectionString: "", secret: "", adapter: new MemoryAdapter() as unknown as AdapterLike }), /NIXAMP_JWT_SECRET/);
});
