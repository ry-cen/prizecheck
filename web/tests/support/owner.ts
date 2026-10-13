import { test } from "@playwright/test";
import type { Pool } from "pg";

// Every test on a stack signs in with the same owner email. Left alone, each test would also see every Location and
// Holding that earlier tests on that stack made, so its sidebar, its Tab order and where its drop targets sit would
// depend on what ran before it: the burn-in, which repeats a spec on one stack, pushed a drag test's target row below
// the window. Deleting the owner's account (its sessions and accounts cascade) makes the next sign-in create a new
// user, whose inventory the API starts with Unsorted alone; what earlier tests made stays with the old user id, which
// nothing reads again.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
let started: object | undefined;

/**
 * Called by a spec's signIn before it signs in. The first call in a test retires the owner's account, so the test
 * starts with an empty Location tree; a later call in the same test (signing in another tab) keeps the new account.
 */
export async function startAsNewOwner(pool: Pool) {
  const info = test.info();
  if (started === info) return;
  started = info;
  await pool.query('DELETE FROM "user" WHERE email=$1', [OWNER_EMAIL]);
}
