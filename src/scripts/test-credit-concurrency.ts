/**
 * Regression check: concurrent extra-credit reservations must never admit
 * more readings than credits held.
 *
 * Creates a throwaway user with 1 extra credit and no plan, fires N
 * concurrent reserveAllowance() calls, and asserts exactly one is admitted.
 * Run with: pnpm --filter @workspace/api-server exec tsx src/scripts/test-credit-concurrency.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { reserveAllowance } from "../lib/entitlements";

const TEST_USER_ID = `test-credit-race-${Date.now()}`;

async function main() {
  await db.execute(
    sql`INSERT INTO users (id, email, extra_credits) VALUES (${TEST_USER_ID}, ${`${TEST_USER_ID}@example.test`}, 1)`,
  );
  try {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => reserveAllowance(TEST_USER_ID)),
    );
    const admitted = results.filter((r) => r.canRead).length;
    const [{ rows }] = [
      await db.execute(
        sql`SELECT extra_credits FROM users WHERE id = ${TEST_USER_ID}`,
      ),
    ];
    const remaining = Number((rows[0] as { extra_credits: number }).extra_credits);
    console.log({ admitted, remaining });
    if (admitted !== 1 || remaining !== 0) {
      throw new Error(
        `Expected exactly 1 admission and 0 credits remaining, got admitted=${admitted}, remaining=${remaining}`,
      );
    }
    console.log("PASS: only one concurrent request consumed the single credit");
  } finally {
    await db.execute(sql`DELETE FROM users WHERE id = ${TEST_USER_ID}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
