import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import type { EventPreview } from "./events.ts";
import { hash } from "./store.ts";
import {
  eventCatalogReader,
  type EventCatalogReader,
  type EventCatalogQuery,
} from "./event-catalog.ts";
import {
  EventCancellationFailure,
  eventCancellationTransaction,
} from "./event-cancellation-lifetime.ts";
import {
  eventCancellationScope,
  type EventCancellationResult,
} from "./event-cancellation-values.ts";

export interface MemberEventCatalog {
  list(token: string): Promise<EventCancellationResult<EventPreview[]>>;
  find(
    token: string,
    id: string,
    version: number,
  ): Promise<EventCancellationResult<EventPreview | undefined>>;
}

/** Catalog facts are shared local content, not an attendee directory. Current
 * member/workspace authority still owns every bounded read and HTTP lifetime. */
export function memberEventCatalog(
  pool: Pool,
  mode: ApplicationMode,
  reader: EventCatalogReader = eventCatalogReader(),
): MemberEventCatalog {
  async function run<T>(
    token: string,
    use: (tx: EventCatalogQuery) => Promise<T>,
  ): Promise<EventCancellationResult<T>> {
    if (
      typeof token !== "string" ||
      !token.trim() ||
      !["demo", "test"].includes(mode)
    )
      return { kind: "denied" };
    return eventCancellationTransaction(pool, false, async (tx) => {
      const member = (
        await tx.query<{ id: string; expires: Date }>(
          `SELECT id,expires_at AS expires FROM principals
         WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL
          AND expires_at>clock_timestamp() FOR SHARE`,
          [hash(token)],
        )
      ).rows[0];
      if (!member) throw new EventCancellationFailure("denied");
      await tx.observe([member.expires]);
      const workspace = (
        await tx.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE`,
          [member.id],
        )
      ).rows[0];
      if (!workspace) throw new EventCancellationFailure("denied");
      const value = await use(tx);
      await tx.observe([member.expires]);
      return () => value;
    });
  }
  return {
    list(token) {
      return run(token, (tx) => reader.list(tx));
    },
    find(token, id, version) {
      if (!eventCancellationScope({ eventId: id, eventVersion: version }))
        return Promise.resolve({ kind: "invalid" });
      return run(token, (tx) =>
        reader.acceptsReference(id, version)
          ? reader.find(tx, id, version)
          : Promise.resolve(undefined),
      );
    },
  };
}
