import type { Pool } from "pg";
import { isFresh, unlinkPlan } from "./signIns.js";

export type RemoveSignInRequest = {
  userId: string;
  sessionId: string;
  providerId: string;
};
export type RemoveSignInResult =
  | { kind: "unlinked" }
  | { kind: "not-linked" }
  | { kind: "last" }
  | { kind: "not-fresh" };

/** Serializes removal for one collector, including authorization and eligibility after any lock wait. */
export function createSignInRemoval(
  pool: Pool,
  configured: readonly { id: string }[]
): (request: RemoveSignInRequest) => Promise<RemoveSignInResult> {
  const providers = configured.map(({ id }) => ({ id }));
  return async ({ userId, sessionId, providerId }) => {
    const client = await pool.connect();
    let committed = false;
    let discard = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const user = await client.query(
        'SELECT id FROM "user" WHERE id=$1 FOR NO KEY UPDATE',
        [userId]
      );
      if (!user.rowCount) throw new Error("Authentication invalidated");
      const session = await client.query<{
        createdAt: Date;
        expiresAt: Date;
      }>(
        'SELECT "createdAt", "expiresAt" FROM "session" WHERE id=$1 AND "userId"=$2',
        [sessionId, userId]
      );
      const now = Date.now();
      if (!session.rowCount || session.rows[0].expiresAt.getTime() < now)
        throw new Error("Authentication invalidated");
      let result: RemoveSignInResult;
      if (!isFresh(session.rows[0].createdAt, now)) {
        result = { kind: "not-fresh" };
      } else if (!providers.some(({ id }) => id === providerId)) {
        result = { kind: "not-linked" };
      } else {
        // A separate READ COMMITTED statement sees removals committed by the previous lock holder.
        const accounts = await client.query<{
          id: string;
          providerId: string;
          createdAt: Date;
        }>(
          'SELECT id, "providerId", "createdAt" FROM "account" WHERE "userId"=$1',
          [userId]
        );
        const plan = unlinkPlan(
          accounts.rows.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          })),
          providerId,
          providers
        );
        if (plan.kind === "unlink") {
          await client.query(
            'DELETE FROM "account" WHERE "userId"=$1 AND "providerId"=$2',
            [userId, providerId]
          );
          result = { kind: "unlinked" };
        } else {
          result = plan;
        }
      }
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
      }
      // A lost COMMIT acknowledgement is ambiguous; never retry the operation automatically.
      throw error;
    } finally {
      client.release(discard);
    }
  };
}
