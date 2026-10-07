import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { EVENT_PREVIEWS, type EventPreview } from "./events.ts";
import {
  eventCatalogReader,
  type EventCatalogReader,
} from "./event-catalog.ts";
import { hash } from "./store.ts";
import { staffCredential } from "./staff-entry-selection.ts";
import {
  EventCancellationFailure,
  eventCancellationTransaction,
  type EventCancellationTransaction,
} from "./event-cancellation-lifetime.ts";
import {
  eventCancellationId,
  eventCancellationScope,
  type EventCancellationStore,
  type EventCancellationScope,
  type EventCancellationReceipt,
  type EventCancellationResult,
  type EventCancellationSnapshot,
} from "./event-cancellation-values.ts";
interface Context {
  tx: EventCancellationTransaction;
  actorId: string;
  expires: Date;
}
interface Operation extends EventCancellationScope {
  actorId: string | null;
  cancellationId: string;
}
interface Inventory {
  title: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
}
const demand: (
  value: unknown,
  kind?: "denied" | "invalid" | "conflict" | "unavailable",
) => asserts value = (value, kind = "denied") => {
  if (!value) throw new EventCancellationFailure(kind);
};
const columns = `c.id,c.event_id AS "eventId",c.event_version AS "eventVersion",c.cancelled_at AS "cancelledAt",i.title,i.starts_at AS "startsAt",i.ends_at AS "endsAt"`;
const from = `private_event_cancellations c JOIN private_event_inventory i USING(event_id,event_version)`;
export function eventCancellationStore(
  pool: Pool,
  options: {
    mode: ApplicationMode;
    writes: boolean;
    registration: boolean;
    catalog?: readonly EventPreview[];
    catalogReader?: EventCatalogReader;
  },
): EventCancellationStore {
  const reader =
      options.catalogReader ??
      eventCatalogReader(options.catalog ?? EVENT_PREVIEWS),
    creationEnabled = options.writes && options.registration;
  async function run<T>(
    token: string,
    writing: boolean,
    use: (ctx: Context) => Promise<T>,
  ): Promise<EventCancellationResult<T>> {
    if (!staffCredential(token) || !["test", "demo"].includes(options.mode))
      return { kind: "denied" };
    return eventCancellationTransaction(pool, writing, async (tx) => {
      const tokenHash = hash(token),
        actor = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [tokenHash],
          )
        ).rows[0];
      demand(actor);
      await tx.observe([actor.expires]);
      const profile = (
        await tx.query<{ role: string }>(
          "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR SHARE",
          [actor.id],
        )
      ).rows[0];
      demand(profile?.role === "platform_admin");
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
  async function receipt(ctx: Context, scope: EventCancellationScope) {
    return (
      (
        await ctx.tx.query<EventCancellationReceipt>(
          `SELECT ${columns} FROM ${from} WHERE c.event_id=$1 AND c.event_version=$2`,
          [scope.eventId, scope.eventVersion],
        )
      ).rows[0] ?? null
    );
  }
  async function operation(ctx: Context, key: string) {
    return (
      await ctx.tx.query<Operation>(
        `SELECT actor_id AS "actorId",event_id AS "eventId",event_version AS "eventVersion",cancellation_id AS "cancellationId" FROM private_event_cancellation_operations WHERE idempotency_key=$1 FOR SHARE`,
        [key],
      )
    ).rows[0];
  }
  function exact(ctx: Context, scope: EventCancellationScope, op: Operation) {
    demand(
      op.actorId === ctx.actorId &&
        op.eventId === scope.eventId &&
        op.eventVersion === scope.eventVersion,
      "conflict",
    );
  }
  function eligible(
    event: EventPreview | undefined,
  ): asserts event is EventPreview {
    demand(
      creationEnabled &&
        event?.status === "current" &&
        event.localRegistration === true,
      "unavailable",
    );
  }
  const matchingSnapshot = (
    event: EventPreview,
    snapshot?: EventCancellationSnapshot,
  ) =>
    !snapshot ||
    (snapshot.title === event.title &&
      snapshot.startsAt === event.startsAt &&
      snapshot.endsAt === event.endsAt &&
      snapshot.capacity === event.fixtureCapacity);
  async function matchingReceipt(
    ctx: Context,
    scope: EventCancellationScope,
    snapshot?: EventCancellationSnapshot,
  ) {
    const saved = await receipt(ctx, scope);
    demand(saved, "unavailable");
    if (snapshot) {
      const row = (
        await ctx.tx.query<{ capacity: number }>(
          "SELECT capacity FROM private_event_inventory WHERE event_id=$1 AND event_version=$2",
          [scope.eventId, scope.eventVersion],
        )
      ).rows[0];
      demand(
        row &&
          snapshot.title === saved.title &&
          snapshot.startsAt === saved.startsAt.toISOString() &&
          snapshot.endsAt === saved.endsAt.toISOString() &&
          snapshot.capacity === row.capacity,
        "conflict",
      );
    }
    return saved;
  }
  async function inventory(
    ctx: Context,
    scope: EventCancellationScope,
    event: EventPreview,
  ) {
    await ctx.tx.query(
      `INSERT INTO private_event_inventory(event_id,event_version,title,starts_at,ends_at,capacity) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        scope.eventId,
        scope.eventVersion,
        event.title,
        event.startsAt,
        event.endsAt,
        event.fixtureCapacity,
      ],
    );
    const saved = (
      await ctx.tx.query<Inventory>(
        `SELECT title,starts_at AS "startsAt",ends_at AS "endsAt",capacity FROM private_event_inventory WHERE event_id=$1 AND event_version=$2 FOR UPDATE`,
        [scope.eventId, scope.eventVersion],
      )
    ).rows[0];
    demand(
      saved &&
        saved.title === event.title &&
        saved.startsAt.toISOString() === event.startsAt &&
        saved.endsAt.toISOString() === event.endsAt &&
        saved.capacity === event.fixtureCapacity,
      "conflict",
    );
    const state = (
      await ctx.tx.query<{ id: string | null }>(
        `SELECT cancellation_id AS id FROM private_event_cancellation_state WHERE event_id=$1 AND event_version=$2 FOR UPDATE`,
        [scope.eventId, scope.eventVersion],
      )
    ).rows[0];
    demand(state, "unavailable");
    return state;
  }
  return {
    admin(token) {
      return run(token, false, async () => ({ creationEnabled }));
    },
    preview(token, scope) {
      if (!eventCancellationScope(scope))
        return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        const event = await reader.find(
          ctx.tx,
          scope.eventId,
          scope.eventVersion,
        );
        demand(
          event?.status === "current" && event.localRegistration === true,
          "unavailable",
        );
        const saved = await receipt(ctx, scope);
        const future =
          (
            await ctx.tx.query<{ future: boolean }>(
              "SELECT $1::timestamptz>clock_timestamp() AS future",
              [event.startsAt],
            )
          ).rows[0]?.future === true;
        const canCreate = creationEnabled && future && !saved;
        if (canCreate)
          await ctx.tx.observe([ctx.expires, new Date(event.startsAt)]);
        return { event, creationEnabled: canCreate, receipt: saved };
      });
    },
    inspect(token, scope) {
      if (!eventCancellationScope(scope))
        return Promise.resolve({ kind: "invalid" });
      return run(token, false, (ctx) => receipt(ctx, scope));
    },
    inspectOperation(token, scope, key) {
      if (!eventCancellationScope(scope) || !eventCancellationId(key))
        return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => {
        const op = await operation(ctx, key);
        if (!op) return null;
        exact(ctx, scope, op);
        const saved = await receipt(ctx, scope);
        demand(saved?.id === op.cancellationId, "unavailable");
        return saved;
      });
    },
    cancel(token, scope, key, snapshot) {
      if (!eventCancellationScope(scope) || !eventCancellationId(key))
        return Promise.resolve({ kind: "invalid" });
      return run(token, true, async (ctx) => {
        let prior = await operation(ctx, key);
        if (prior) {
          exact(ctx, scope, prior);
          const saved = await matchingReceipt(ctx, scope, snapshot);
          demand(saved?.id === prior.cancellationId, "unavailable");
          return { receipt: saved, replayed: true };
        }
        const event = await reader.find(
          ctx.tx,
          scope.eventId,
          scope.eventVersion,
        );
        eligible(event);
        demand(matchingSnapshot(event, snapshot), "conflict");
        await ctx.tx.observe([ctx.expires, new Date(event.startsAt)]);
        const state = await inventory(ctx, scope, event);
        await ctx.tx.observe([ctx.expires, new Date(event.startsAt)]);
        prior = await operation(ctx, key);
        if (prior) {
          exact(ctx, scope, prior);
          const saved = await matchingReceipt(ctx, scope, snapshot);
          demand(saved?.id === prior.cancellationId, "unavailable");
          return { receipt: saved, replayed: true };
        }
        const id = state.id ?? randomUUID();
        if (!state.id) {
          await ctx.tx.query(
            `INSERT INTO private_event_cancellations(id,event_id,event_version,cancelled_at) VALUES($1,$2,$3,clock_timestamp())`,
            [id, scope.eventId, scope.eventVersion],
          );
          await ctx.tx.query(
            `UPDATE private_event_cancellation_state SET cancellation_id=$1 WHERE event_id=$2 AND event_version=$3 AND cancellation_id IS NULL`,
            [id, scope.eventId, scope.eventVersion],
          );
        }
        const inserted = await ctx.tx.query(
          `INSERT INTO private_event_cancellation_operations(idempotency_key,actor_id,event_id,event_version,cancellation_id,action) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
          [
            key,
            ctx.actorId,
            scope.eventId,
            scope.eventVersion,
            id,
            state.id ? "already-cancelled" : "cancelled",
          ],
        );
        if (!inserted.rows.length) {
          const winner = await operation(ctx, key);
          demand(winner, "unavailable");
          exact(ctx, scope, winner);
          demand(winner.cancellationId === id, "conflict");
        }
        const saved = await receipt(ctx, scope);
        demand(saved?.id === id, "unavailable");
        await ctx.tx.observe([ctx.expires, new Date(event.startsAt)]);
        return { receipt: saved, replayed: false };
      });
    },
  };
}
