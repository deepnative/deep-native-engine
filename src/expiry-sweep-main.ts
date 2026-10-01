import { Pool } from "pg";
import { config } from "./config.ts";
import { ExpirySweepFailure, syntheticLedger } from "./ledger.ts";

let pool: Pool | undefined;
let failed = false;
let progress: { processed: number; skipped: number; moreDue: boolean | null } =
  {
    processed: 0,
    skipped: 0,
    moreDue: null,
  };
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--limit" ||
    !/^[1-9][0-9]{0,2}$/.test(args[1]!) ||
    Number(args[1]) > 500
  )
    throw new Error("Use --limit with an integer from 1 through 500.");
  const settings = config(process.env);
  pool = new Pool({
    connectionString: settings.databaseUrl,
    application_name: "deep-native-synthetic-expiry",
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on("error", () => {
    failed = true;
  });
  progress = await syntheticLedger(pool).sweepExpired(Number(args[1]));
} catch (error) {
  failed = true;
  if (error instanceof ExpirySweepFailure)
    progress = {
      processed: error.processed,
      skipped: error.skipped,
      moreDue: null,
    };
} finally {
  if (pool)
    await pool.end().catch(() => {
      failed = true;
    });
}
// Do not serialize exceptions, configuration, candidates, or idempotency keys.
// A failed final query/shutdown cannot report a successful completed batch.
const summary = JSON.stringify({
  status: failed ? "failed" : "complete",
  ...progress,
  moreDue: failed ? null : progress.moreDue,
});
if (failed) {
  console.error(summary);
  process.exitCode = 1;
} else {
  console.info(summary);
}
