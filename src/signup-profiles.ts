/**
 * The shared profile every Profullstack property asks for at sign-up: first
 * and last name, company domain, job title and LinkedIn, beside the email.
 *
 * Kept by @profullstack/profile in its own `user_profiles` table, keyed by the
 * auth-system user id, and never in `nixamp_profiles`: that one is the host
 * card a classroom shows to strangers, and these fields are the account's own.
 * The table is made on first use, like every other nixamp table, because
 * nixamp carries no migration runner.
 */
import { createProfileStore, type ProfileStore, schemaSql } from "@profullstack/profile";
import type { Queryable } from "./follows.ts";

/** The fields the web sign-up form sends; a client that sends none is not asked for them. */
export const SIGNUP_PROFILE_FIELDS = ["first_name", "last_name", "company_domain", "job_title", "linkedin_url"] as const;

export function signupProfiles(db: Queryable): ProfileStore {
  let ready: Promise<unknown> | null = null;
  const ensure = (): Promise<unknown> =>
    (ready ??= db.query(schemaSql({ keyType: "text" })).catch((error: unknown) => {
      ready = null;
      throw error;
    }));
  return createProfileStore(
    {
      query: async (text: string, values?: unknown[]) => {
        await ensure();
        return db.query(text, values);
      },
    },
    { keyType: "text" },
  );
}
