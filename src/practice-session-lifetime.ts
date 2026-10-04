import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
export type PracticeFailureKind = "denied" | "unavailable";
export class PracticeLifetimeFailure extends Error {
  readonly kind: PracticeFailureKind;
  constructor(kind: PracticeFailureKind) {
    super("Practice session unavailable");
    this.kind = kind;
  }
}
export interface PracticeTransaction {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  bounded<T>(use: () => Promise<T>): Promise<T>;
  observe(expires: Date[]): Promise<void>;
}
/** One owned transaction; source/authority fences are acquired by the caller in
 * documented order. No retry, no rollback behind an unknown query/commit. */
export async function practiceTransaction<T>(
  pool: Pool,
  use: (transaction: PracticeTransaction) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + 10000;
  let authority = Infinity,
    client: PoolClient | undefined;
  let uncertain = false,
    open = false,
    commitIssued = false;
  let result: T | undefined, failure: PracticeLifetimeFailure | undefined;
  const unavailable = () => new PracticeLifetimeFailure("unavailable");
  const expired = () => new PracticeLifetimeFailure("denied");
  async function bounded<V>(
    operation: () => Promise<V>,
    maximum = 5000,
  ): Promise<V> {
    const entered = performance.now();
    const allowance = Math.min(
      maximum,
      deadline - entered,
      authority - entered,
    );
    const authorityLimited =
      authority - entered <= Math.min(maximum, deadline - entered);
    if (allowance <= 0) throw authorityLimited ? expired() : unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            uncertain = true;
            reject(authorityLimited ? expired() : unavailable());
          }, allowance);
        }),
      ]);
      if (performance.now() - entered >= allowance) {
        uncertain = true;
        throw authorityLimited ? expired() : unavailable();
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  const query = <V extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ) => bounded(() => client!.query<V>(sql, values));
  async function observe(expires: Date[]) {
    if (
      !expires.length ||
      expires.some(
        (value) => !(value instanceof Date) || !Number.isFinite(+value),
      )
    )
      throw unavailable();
    const entered = performance.now();
    const row = (
      await query<{ remaining: string; valid: boolean; observed: Date }>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS observed)
       SELECT observed, EXTRACT(EPOCH FROM ($1::timestamptz-observed))*1000 AS remaining,
         $1::timestamptz>observed AS valid FROM instant`,
        [new Date(Math.min(...expires.map(Number)))],
      )
    ).rows[0];
    if (
      !row ||
      typeof row.remaining !== "string" ||
      !row.remaining.trim() ||
      !Number.isFinite(Number(row.remaining)) ||
      !(row.observed instanceof Date) ||
      !Number.isFinite(+row.observed) ||
      typeof row.valid !== "boolean"
    )
      throw unavailable();
    authority = Math.min(authority, entered + Number(row.remaining));
    if (!row.valid || performance.now() >= authority) throw expired();
  }
  try {
    let acquisitionExpired = false,
      acquired: PoolClient | undefined;
    try {
      client = await bounded(
        () =>
          pool.connect().then((value) => {
            if (acquisitionExpired) {
              try {
                value.release(unavailable());
              } catch {
                /* Already unavailable. */
              }
              throw unavailable();
            }
            acquired = value;
            return value;
          }),
        3000,
      );
    } catch (error) {
      acquisitionExpired = true;
      if (acquired) {
        try {
          acquired.release(unavailable());
        } catch {
          /* Already unavailable. */
        }
      }
      throw error;
    }
    await query("BEGIN ISOLATION LEVEL READ COMMITTED");
    open = true;
    await query("SET LOCAL statement_timeout='5s'");
    await query("SET LOCAL lock_timeout='5s'");
    await query("SELECT set_config('transaction_timeout',$1,true)", [
      `${Math.max(1, Math.floor(deadline - performance.now()))}ms`,
    ]);
    result = await use({ query, bounded, observe });
    // The caller's last DB observation must precede handback; refusing an
    // unobserved callback prevents accidentally adding a new unfenced path.
    if (!Number.isFinite(authority)) throw unavailable();
    if (performance.now() >= authority) throw expired();
    commitIssued = true;
    await query("COMMIT");
    open = false;
  } catch (error) {
    failure = error instanceof PracticeLifetimeFailure ? error : unavailable();
  } finally {
    if (client && open && !uncertain && !commitIssued) {
      try {
        await query("ROLLBACK");
      } catch {
        failure = unavailable();
      }
    }
    try {
      client?.release(unavailable());
    } catch {
      failure = unavailable();
    }
  }
  if (performance.now() >= deadline) failure = unavailable();
  else if (performance.now() >= authority) failure = expired();
  if (failure) throw failure;
  return result as T;
}
