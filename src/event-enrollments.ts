import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { EVENT_PREVIEWS, type EventPreview } from "./events.ts";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";

export interface EventEnrollmentReceipt {
  id: string;
  eventId: string;
  eventVersion: number;
  title: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  withdrawnAt: Date | null;
}
export type EventEnrollmentOutcome =
  | { kind: "enrolled" | "replayed" | "already-enrolled"; receiptId: string }
  | { kind: "full" | "unavailable" | "conflict" };
export interface EventEnrollmentPreview {
  event: EventPreview;
  canEnroll: boolean;
  remaining: number | null;
  activeReceiptId: string | null;
}
export interface EventEnrollmentStore {
  preview(
    token: string,
    eventId: string,
    version: number,
  ): Promise<EventEnrollmentPreview | null>;
  enroll(
    token: string,
    eventId: string,
    version: number,
    operationId: string,
  ): Promise<EventEnrollmentOutcome>;
  receipt(token: string, id: string): Promise<EventEnrollmentReceipt | null>;
  history(
    token: string,
    after?: string,
  ): Promise<{
    items: EventEnrollmentReceipt[];
    nextCursor: string | null;
  } | null>;
  withdraw(
    token: string,
    id: string,
  ): Promise<"withdrawn" | "already-withdrawn" | "unavailable">;
}
export function disabledEventEnrollmentStore(): EventEnrollmentStore {
  return {
    preview: async () => null,
    enroll: async () => ({ kind: "unavailable" }),
    receipt: async () => null,
    history: async () => null,
    withdraw: async () => "unavailable",
  };
}
const idPattern = /^[a-z][a-z0-9-]{0,79}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validVersion = (version: number) =>
  Number.isInteger(version) && version >= 1 && version <= 1000000;
const receiptColumns = `e.id,e.event_id AS "eventId",e.event_version AS "eventVersion",
 i.title,i.starts_at AS "startsAt",i.ends_at AS "endsAt",e.created_at AS "createdAt",e.withdrawn_at AS "withdrawnAt"`;
const receiptJoin = `private_event_enrollments e JOIN private_event_inventory i
 ON i.event_id=e.event_id AND i.event_version=e.event_version AND i.capacity=e.capacity`;
type Inventory = {
  title: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
};
export function eventEnrollmentStore(
  pool: Pool,
  options: {
    mode: ApplicationMode;
    enabled: boolean;
    catalog?: readonly EventPreview[];
  },
): EventEnrollmentStore {
  const catalog = options.catalog ?? EVENT_PREVIEWS;
  const local = options.mode === "demo" || options.mode === "test";
  const find = (id: string, version: number) =>
    catalog.find((event) => event.id === id && event.version === version);
  const eligible = (event: EventPreview | undefined): event is EventPreview =>
    local &&
    options.enabled &&
    !!event &&
    event.localRegistration === true &&
    event.status === "current";
  async function owned<T>(
    token: string,
    use: (
      tx: PracticeTransaction,
      member: string,
      workspace: string,
    ) => Promise<T>,
  ): Promise<T | null> {
    if (!local || typeof token !== "string" || !token.trim()) return null;
    try {
      return await practiceTransaction(pool, async (tx) => {
        const principal = (
          await tx.query<{ id: string; expires_at: Date }>(
            `SELECT id,expires_at FROM principals WHERE token_hash=$1 AND kind='member'
           AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) throw new PracticeLifetimeFailure("denied");
        await tx.observe([principal.expires_at]);
        const workspace = (
          await tx.query<{ id: string }>(
            `SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE`,
            [principal.id],
          )
        ).rows[0];
        if (!workspace) throw new PracticeLifetimeFailure("denied");
        const result = await use(tx, principal.id, workspace.id);
        await tx.observe([principal.expires_at]);
        return result;
      });
    } catch (error) {
      if (error instanceof PracticeLifetimeFailure && error.kind === "denied")
        return null;
    }
    // Driver diagnostics may contain private parameters; keep this boundary generic.
    throw new Error("Private event registration unavailable");
  }
  const matches = (inventory: Inventory, event: EventPreview) =>
    inventory.title === event.title &&
    inventory.capacity === event.fixtureCapacity &&
    inventory.startsAt.toISOString() === event.startsAt &&
    inventory.endsAt.toISOString() === event.endsAt;
  async function activeSeats(
    tx: PracticeTransaction,
    id: string,
    version: number,
    capacity: number,
  ) {
    const rows = (
      await tx.query<{ seat_number: number }>(
        `SELECT seat_number FROM private_event_enrollments WHERE event_id=$1 AND event_version=$2
       AND withdrawn_at IS NULL ORDER BY seat_number LIMIT 101`,
        [id, version],
      )
    ).rows;
    if (
      rows.length > capacity ||
      rows.some((row) => row.seat_number < 1 || row.seat_number > capacity)
    )
      throw new Error("Invalid private event seat state");
    return new Set(rows.map((row) => row.seat_number));
  }
  async function receipt(
    tx: PracticeTransaction,
    member: string,
    workspace: string,
    id: string,
  ) {
    return (
      (
        await tx.query<EventEnrollmentReceipt>(
          `SELECT ${receiptColumns} FROM ${receiptJoin} WHERE e.member_id=$1 AND e.workspace_id=$2 AND e.id=$3`,
          [member, workspace, id],
        )
      ).rows[0] ?? null
    );
  }
  return {
    async preview(token, eventId, version) {
      if (!idPattern.test(eventId) || !validVersion(version)) return null;
      const event = find(eventId, version);
      if (!event) return null;
      return owned(token, async (tx, member, workspace) => {
        const inventory = (
          await tx.query<Inventory>(
            `SELECT title,starts_at AS "startsAt",ends_at AS "endsAt",capacity FROM private_event_inventory
           WHERE event_id=$1 AND event_version=$2 FOR SHARE`,
            [eventId, version],
          )
        ).rows[0];
        const active = (
          await tx.query<{ id: string }>(
            `SELECT id FROM private_event_enrollments WHERE member_id=$1 AND workspace_id=$2
           AND event_id=$3 AND event_version=$4 AND withdrawn_at IS NULL`,
            [member, workspace, eventId, version],
          )
        ).rows[0];
        const future =
          (
            await tx.query<{ future: boolean }>(
              `SELECT $1::timestamptz>clock_timestamp() AS future`,
              [event.startsAt],
            )
          ).rows[0]?.future === true;
        const canEnroll =
          eligible(event) &&
          future &&
          (!inventory || matches(inventory, event));
        const seats =
          canEnroll && inventory
            ? await activeSeats(tx, eventId, version, inventory.capacity)
            : null;
        return {
          event,
          canEnroll,
          remaining: canEnroll
            ? event.fixtureCapacity - (seats?.size ?? 0)
            : null,
          activeReceiptId: active?.id ?? null,
        };
      });
    },
    async enroll(token, eventId, version, operationId) {
      if (
        !idPattern.test(eventId) ||
        !validVersion(version) ||
        !uuidPattern.test(operationId)
      )
        return { kind: "unavailable" };
      return (
        (await owned<EventEnrollmentOutcome>(
          token,
          async (tx, member, workspace) => {
            const prior = await receipt(tx, member, workspace, operationId);
            if (prior)
              return prior.eventId === eventId && prior.eventVersion === version
                ? { kind: "replayed", receiptId: prior.id }
                : { kind: "conflict" };
            const active = (
              await tx.query<{ id: string }>(
                `SELECT id FROM private_event_enrollments
          WHERE member_id=$1 AND workspace_id=$2 AND event_id=$3 AND event_version=$4 AND withdrawn_at IS NULL`,
                [member, workspace, eventId, version],
              )
            ).rows[0];
            if (active)
              return { kind: "already-enrolled", receiptId: active.id };
            const event = find(eventId, version);
            if (!eligible(event)) return { kind: "unavailable" };
            await tx.query(
              `INSERT INTO private_event_inventory(event_id,event_version,title,starts_at,ends_at,capacity)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
              [
                eventId,
                version,
                event.title,
                event.startsAt,
                event.endsAt,
                event.fixtureCapacity,
              ],
            );
            const inventory = (
              await tx.query<Inventory>(
                `SELECT title,starts_at AS "startsAt",ends_at AS "endsAt",capacity
          FROM private_event_inventory WHERE event_id=$1 AND event_version=$2 FOR UPDATE`,
                [eventId, version],
              )
            ).rows[0];
            if (!inventory || !matches(inventory, event))
              return { kind: "unavailable" };
            await tx.observe([inventory.startsAt]);
            const seats = await activeSeats(
              tx,
              eventId,
              version,
              inventory.capacity,
            );
            let seat = 1;
            while (seats.has(seat)) seat++;
            if (seat > inventory.capacity) return { kind: "full" };
            await tx.query(
              `INSERT INTO private_event_enrollments(id,member_id,workspace_id,event_id,event_version,capacity,seat_number)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                operationId,
                member,
                workspace,
                eventId,
                version,
                inventory.capacity,
                seat,
              ],
            );
            return { kind: "enrolled", receiptId: operationId };
          },
        )) ?? { kind: "unavailable" }
      );
    },
    async receipt(token, id) {
      if (!uuidPattern.test(id)) return null;
      return owned(token, (tx, member, workspace) =>
        receipt(tx, member, workspace, id),
      );
    },
    async history(token, after) {
      if (after !== undefined && !uuidPattern.test(after)) return null;
      return owned(token, async (tx, member, workspace) => {
        const rows = (
          await tx.query<EventEnrollmentReceipt>(
            `SELECT ${receiptColumns} FROM ${receiptJoin}
          WHERE e.member_id=$1 AND e.workspace_id=$2 AND ($3::uuid IS NULL OR e.id>$3::uuid)
          ORDER BY e.id LIMIT 21`,
            [member, workspace, after ?? null],
          )
        ).rows;
        const items = rows.slice(0, 20);
        return { items, nextCursor: rows.length > 20 ? items[19]!.id : null };
      });
    },
    async withdraw(token, id) {
      if (!uuidPattern.test(id)) return "unavailable";
      return (
        (await owned<"withdrawn" | "already-withdrawn" | "unavailable">(
          token,
          async (tx, member, workspace) => {
            const prior = await receipt(tx, member, workspace, id);
            if (!prior) return "unavailable";
            await tx.query(
              `SELECT event_id FROM private_event_inventory WHERE event_id=$1 AND event_version=$2 FOR UPDATE`,
              [prior.eventId, prior.eventVersion],
            );
            const current = (
              await tx.query<{ withdrawn_at: Date | null }>(
                `SELECT withdrawn_at FROM private_event_enrollments
          WHERE id=$1 AND member_id=$2 AND workspace_id=$3 FOR UPDATE`,
                [id, member, workspace],
              )
            ).rows[0];
            if (!current) return "unavailable";
            if (current.withdrawn_at) return "already-withdrawn";
            await tx.query(
              `UPDATE private_event_enrollments SET withdrawn_at=clock_timestamp() WHERE id=$1`,
              [id],
            );
            return "withdrawn";
          },
        )) ?? "unavailable"
      );
    },
  };
}
