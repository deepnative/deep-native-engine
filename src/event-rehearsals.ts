import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { hash } from "./store.ts";
import { staffCredential } from "./staff-entry-selection.ts";
import {
  eventCancellationId,
  type EventCancellationResult,
} from "./event-cancellation-values.ts";
import {
  EventCancellationFailure,
  eventCancellationTransaction,
  type EventCancellationTransaction,
} from "./event-cancellation-lifetime.ts";
import {
  REHEARSAL_TEMPLATE,
  checkedRehearsalSnapshot,
  rehearsalSnapshot,
  type RehearsalSnapshot,
  type RehearsalReceipt,
  type EventRehearsalStore,
} from "./event-rehearsal-values.ts";

interface Context {
  tx: EventCancellationTransaction;
  actorId: string;
  expires: Date;
}
interface SavedOperation extends RehearsalReceipt {
  actorId: string | null;
  snapshot: unknown;
}
const demand: (
  value: unknown,
  kind?: "denied" | "invalid" | "conflict" | "unavailable",
) => asserts value = (value, kind = "unavailable") => {
  if (!value) throw new EventCancellationFailure(kind);
};
const columns = `r.id,r.event_id AS "eventId",r.event_version AS "eventVersion",
 i.title,i.starts_at AS "startsAt",i.ends_at AS "endsAt",r.scheduled_at AS "scheduledAt"`;
const source = `private_event_rehearsals r JOIN private_event_inventory i USING(event_id,event_version)`;

export function eventRehearsalStore(
  pool: Pool,
  options: { mode: ApplicationMode; writes: boolean; registration: boolean },
): EventRehearsalStore {
  const creationEnabled = options.writes && options.registration;
  async function run<T>(
    token: string,
    writing: boolean,
    use: (ctx: Context) => Promise<T>,
  ): Promise<EventCancellationResult<T>> {
    if (!staffCredential(token) || !["demo", "test"].includes(options.mode))
      return { kind: "denied" };
    return eventCancellationTransaction(pool, writing, async (tx) => {
      const actor = (
        await tx.query<{ id: string; expires: Date }>(
          `SELECT id,expires_at AS expires FROM principals
         WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL
          AND expires_at>clock_timestamp() FOR SHARE`,
          [hash(token)],
        )
      ).rows[0];
      demand(actor, "denied");
      await tx.observe([actor.expires]);
      const role = (
        await tx.query<{ role: string }>(
          "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR SHARE",
          [actor.id],
        )
      ).rows[0];
      demand(role?.role === "platform_admin", "denied");
      await tx.observe([actor.expires]);
      const value = await use({
        tx,
        actorId: actor.id,
        expires: actor.expires,
      });
      await tx.observe([actor.expires]);
      return () => value;
    });
  }
  const receiptValue = (row: RehearsalReceipt): RehearsalReceipt => ({
    id: row.id,
    eventId: row.eventId,
    eventVersion: row.eventVersion,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    scheduledAt: row.scheduledAt,
  });
  async function operation(ctx: Context, key: string) {
    return (
      await ctx.tx.query<SavedOperation>(
        `SELECT ${columns},o.actor_id AS "actorId",o.checked_snapshot AS snapshot
       FROM ${source} JOIN private_event_rehearsal_operations o ON r.id=o.rehearsal_id
       WHERE o.idempotency_key=$1 FOR SHARE OF o`,
        [key],
      )
    ).rows[0];
  }
  function exact(
    ctx: Context,
    row: SavedOperation,
    snapshot: RehearsalSnapshot,
  ) {
    demand(
      row.actorId === ctx.actorId && isDeepStrictEqual(row.snapshot, snapshot),
      "conflict",
    );
    return receiptValue(row);
  }
  async function window(ctx: Context, snapshot: RehearsalSnapshot) {
    const valid = (
      await ctx.tx.query<{ valid: boolean }>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
       SELECT $1::timestamptz>=now+interval '2 minutes'
        AND $1::timestamptz<=now+interval '30 days' AS valid FROM instant`,
        [snapshot.startsAt],
      )
    ).rows[0]?.valid;
    demand(valid === true, "invalid");
    // The two-minute creation margin also remains valid at commit and handback.
    await ctx.tx.observe([
      ctx.expires,
      new Date(+new Date(snapshot.startsAt) - 120000),
    ]);
  }
  async function hasPlace(ctx: Context) {
    const count = (
      await ctx.tx.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count FROM private_event_rehearsals r
       JOIN private_event_inventory i USING(event_id,event_version)
       WHERE i.starts_at>clock_timestamp() AND NOT EXISTS(
        SELECT 1 FROM private_event_cancellations c
        WHERE c.event_id=r.event_id AND c.event_version=r.event_version)`,
      )
    ).rows[0]?.count;
    demand(typeof count === "number" && Number.isInteger(count) && count >= 0);
    return count < 20;
  }
  return {
    admin(token) {
      return run(token, false, async () => ({ creationEnabled }));
    },
    preview(token, instruction) {
      const snapshot = rehearsalSnapshot(instruction);
      if (!snapshot) return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        await window(ctx, snapshot);
        return {
          snapshot,
          creationEnabled: creationEnabled && (await hasPlace(ctx)),
        };
      });
    },
    schedule(token, key, checked) {
      const snapshot = checkedRehearsalSnapshot(checked);
      if (!eventCancellationId(key) || !snapshot)
        return Promise.resolve({ kind: "invalid" });
      return run(token, true, async (ctx) => {
        let prior = await operation(ctx, key);
        if (prior)
          return { receipt: exact(ctx, prior, snapshot), replayed: true };
        demand(creationEnabled);
        await window(ctx, snapshot);
        const guard = (
          await ctx.tx.query<{ id: number }>(
            "SELECT id FROM private_event_rehearsal_admission WHERE id=1 FOR UPDATE",
          )
        ).rows[0];
        demand(guard);
        // Re-read after admission ownership: a concurrent same-key winner can
        // now be recovered without creating an orphan inventory/schedule row.
        prior = await operation(ctx, key);
        if (prior)
          return { receipt: exact(ctx, prior, snapshot), replayed: true };
        await window(ctx, snapshot);
        demand(await hasPlace(ctx));
        const id = randomUUID(),
          eventId = `local-rehearsal-${id}`;
        await ctx.tx.query(
          `INSERT INTO private_event_inventory(event_id,event_version,title,starts_at,ends_at,capacity)
           VALUES($1,1,$2,$3,$4,$5)`,
          [
            eventId,
            snapshot.title,
            snapshot.startsAt,
            snapshot.endsAt,
            snapshot.capacity,
          ],
        );
        await ctx.tx.query(
          `INSERT INTO private_event_rehearsals(id,event_id,event_version,template_id,
           template_version,template_digest,template_snapshot)
           VALUES($1,$2,1,$3,$4,$5,$6::jsonb)`,
          [
            id,
            eventId,
            snapshot.templateId,
            snapshot.templateVersion,
            snapshot.templateDigest,
            JSON.stringify(REHEARSAL_TEMPLATE),
          ],
        );
        await ctx.tx.query(
          `INSERT INTO private_event_rehearsal_operations(idempotency_key,actor_id,rehearsal_id,checked_snapshot)
           VALUES($1,$2,$3,$4::jsonb)`,
          [key, ctx.actorId, id, JSON.stringify(snapshot)],
        );
        const saved = await operation(ctx, key);
        demand(saved?.id === id);
        const receipt = exact(ctx, saved, snapshot);
        await window(ctx, snapshot);
        return { receipt, replayed: false };
      });
    },
    inspectOperation(token, key, checked) {
      const snapshot = checkedRehearsalSnapshot(checked);
      if (!eventCancellationId(key) || !snapshot)
        return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        const saved = await operation(ctx, key);
        return saved ? exact(ctx, saved, snapshot) : null;
      });
    },
    receipt(token, id) {
      if (!eventCancellationId(id)) return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        const saved = (
          await ctx.tx.query<RehearsalReceipt>(
            `SELECT ${columns} FROM ${source} JOIN private_event_rehearsal_operations o ON r.id=o.rehearsal_id
           WHERE r.id=$1 AND o.actor_id=$2`,
            [id, ctx.actorId],
          )
        ).rows[0];
        return saved ? receiptValue(saved) : null;
      });
    },
  };
}
