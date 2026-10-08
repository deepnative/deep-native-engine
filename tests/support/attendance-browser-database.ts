import type { Pool } from "pg";
/** Wait only for this generated fixture's sessions to finish disconnecting.
 * This never terminates a backend or repeats the browser's application actions. */
export async function dropAttendanceBrowserDatabase(
  control: Pool,
  name: string,
) {
  if (!/^dne_test_[a-f0-9]{32}$/.test(name))
    throw Error("Generated owned browser database required");
  const deadline = performance.now() + 3000;
  const refused = () =>
    Error("Owned browser database still active; no forced deletion");
  for (;;) {
    const remaining = deadline - performance.now();
    // Do not enqueue a final read whose remaining budget is below the polling interval.
    if (remaining <= 25) throw refused();
    // pg supports per-query read timeouts; its QueryConfig typings omit this option.
    const connectionQuery = {
      text: "SELECT COUNT(*)::integer count FROM pg_stat_activity WHERE datname=$1",
      values: [name],
      query_timeout: Math.max(1, Math.min(500, Math.floor(remaining))),
    };
    const active = (await control.query<{ count: number }>(connectionQuery))
      .rows[0]!.count;
    if (performance.now() >= deadline) throw refused();
    if (active === 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, deadline - performance.now())),
    );
  }
  const dropQuery = {
    text: `DROP DATABASE "${name}"`,
    query_timeout: Math.max(1, Math.floor(deadline - performance.now())),
  };
  await control.query(dropQuery);
}
