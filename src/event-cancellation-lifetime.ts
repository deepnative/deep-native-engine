import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { EventCancellationResult } from "./event-cancellation-values.ts";
export type EventCancellationFailureKind =
  "denied" | "invalid" | "conflict" | "unavailable";
export class EventCancellationFailure extends Error {
  constructor(readonly kind: EventCancellationFailureKind) {
    super("Private event cancellation unavailable.");
  }
}
export interface EventCancellationTransaction {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  observe(expires: Date[]): Promise<Date>;
}
/** A single connection owns validation, writes and audit. Its earliest observed
 * lifetime is returned unchanged for the separate synchronous HTTP fence. */
export async function eventCancellationTransaction<T>(
  pool: Pool,
  writing: boolean,
  use: (tx: EventCancellationTransaction) => Promise<(observedAt: Date) => T>,
): Promise<EventCancellationResult<T>> {
  const requestDeadline = performance.now() + 10000;
  let authorityDeadline = Infinity,
    observedAt: Date | undefined,
    client: PoolClient | undefined,
    open = false,
    uncertain = false,
    commitIssued = false,
    failure: EventCancellationFailure | undefined,
    value: T | undefined;
  const unavailable = () => new EventCancellationFailure("unavailable");
  const expired = () =>
    new EventCancellationFailure(
      performance.now() >= requestDeadline || (writing && commitIssued)
        ? "unavailable"
        : "denied",
    );
  const deadline = () => Math.min(requestDeadline, authorityDeadline);
  async function bounded<V>(
    operation: () => Promise<V>,
    maximum = 5000,
  ): Promise<V> {
    const entered = performance.now(),
      allowance = Math.min(maximum, deadline() - entered),
      authorityLimited =
        authorityDeadline <= Math.min(requestDeadline, entered + maximum);
    if (allowance <= 0) throw authorityLimited ? expired() : unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
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
      return result;
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
      expires.some((date) => !(date instanceof Date) || !Number.isFinite(+date))
    )
      throw unavailable();
    const entered = performance.now();
    const row = (
      await query<{ remaining: string; observed: Date }>(
        "WITH instant AS MATERIALIZED (SELECT clock_timestamp() observed) SELECT observed,EXTRACT(EPOCH FROM ($1::timestamptz-observed))*1000 remaining FROM instant",
        [new Date(Math.min(...expires.map(Number)))],
      )
    ).rows[0];
    if (
      !row ||
      typeof row.remaining !== "string" ||
      !row.remaining.trim() ||
      !Number.isFinite(Number(row.remaining)) ||
      !(row.observed instanceof Date) ||
      !Number.isFinite(+row.observed)
    )
      throw unavailable();
    authorityDeadline = Math.min(
      authorityDeadline,
      entered + Number(row.remaining),
    );
    observedAt = row.observed;
    if (performance.now() >= deadline()) throw expired();
    return observedAt;
  }
  try {
    let acquisitionExpired = false,
      acquired: PoolClient | undefined;
    try {
      client = await bounded(
        () =>
          pool.connect().then((connection) => {
            if (acquisitionExpired) {
              try {
                connection.release(unavailable());
              } catch {
                /* Already unavailable. */
              }
              throw unavailable();
            }
            acquired = connection;
            return connection;
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
    await query("BEGIN");
    open = true;
    await query("SET LOCAL statement_timeout='5s'");
    await query("SET LOCAL lock_timeout='5s'");
    await query("SELECT set_config('transaction_timeout',$1,true)", [
      `${Math.max(1, Math.floor(requestDeadline - performance.now()))}ms`,
    ]);
    const project = await use({ query, observe });
    if (!observedAt || !Number.isFinite(authorityDeadline)) throw unavailable();
    value = project(observedAt);
    if (performance.now() >= deadline()) throw expired();
    commitIssued = true;
    await query("COMMIT");
    open = false;
  } catch (error) {
    failure = error instanceof EventCancellationFailure ? error : unavailable();
  } finally {
    if (client && open && !uncertain && !commitIssued) {
      try {
        await query("ROLLBACK");
      } catch {
        failure = unavailable();
      }
    }
    try {
      client?.release(failure || uncertain ? unavailable() : undefined);
    } catch {
      failure = unavailable();
    }
  }
  if (performance.now() >= requestDeadline) failure = unavailable();
  else if (performance.now() >= authorityDeadline) failure = expired();
  if (failure) return { kind: failure.kind };
  return {
    kind: "ready",
    value: value as T,
    observedAt: observedAt!,
    deadline: deadline(),
  };
}
