/**
 * Concurrency test for insertReadingConsumingAllowance.
 * Run: pnpm --filter @workspace/api-server exec tsx src/lib/entitlements.concurrency-test.ts
 *
 * Verifies that with exactly 1 extra credit and no plan, N parallel reading
 * requests result in exactly 1 created reading and 0 remaining credits.
 */
import { sql, eq } from "drizzle-orm";
import { db, pool, usersTable, readingsTable } from "@workspace/db";
import { insertReadingConsumingAllowance } from "./entitlements";

const TEST_USER = `test_concurrency_${Date.now()}`;

async function main() {
  await db.insert(usersTable).values({ id: TEST_USER, extraCredits: 1 });

  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      insertReadingConsumingAllowance(TEST_USER, async (tx) => {
        const [row] = await tx
          .insert(readingsTable)
          .values({
            userId: TEST_USER,
            kind: "face",
            archetype: "test",
            title: "test",
            summary: "test",
            traits: [],
            strengths: [],
            guidance: "test",
            interactionTips: [],
            details: "test",
          })
          .returning();
        return row;
      }).catch((err) => ({ error: String(err) })),
    ),
  );

  const created = results.filter((r) => "row" in r && r.row).length;
  const blocked = results.filter((r) => "blocked" in r && r.blocked).length;
  const errored = results.filter((r) => "error" in r).length;

  const readingCount = await db.execute(
    sql`SELECT count(*)::int AS n FROM readings WHERE user_id = ${TEST_USER}`,
  );
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, TEST_USER));

  // Cleanup
  await db.execute(sql`DELETE FROM readings WHERE user_id = ${TEST_USER}`);
  await db.delete(usersTable).where(eq(usersTable.id, TEST_USER));
  await pool.end();

  const rows = Number((readingCount.rows[0] as { n: number }).n);
  console.log({ created, blocked, errored, readingsInDb: rows, creditsLeft: user?.extraCredits });

  if (created !== 1 || rows !== 1 || user?.extraCredits !== 0) {
    console.error("FAIL: expected exactly 1 reading and 0 credits remaining");
    process.exit(1);
  }
  console.log("PASS: exactly one credit consumed under concurrency");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
