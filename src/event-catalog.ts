import { isDeepStrictEqual } from "node:util";
import { EVENT_PREVIEWS, type EventPreview } from "./events.ts";
import type { EventCancellationTransaction } from "./event-cancellation-lifetime.ts";
import {
  REHEARSAL_TEMPLATE,
  rehearsalSnapshot,
} from "./event-rehearsal-values.ts";

export type EventCatalogQuery = Pick<EventCancellationTransaction, "query">;
export interface EventCatalogReader {
  acceptsReference(id: string, version: number): boolean;
  find(
    query: EventCatalogQuery,
    id: string,
    version: number,
  ): Promise<EventPreview | undefined>;
  list(query: EventCatalogQuery): Promise<EventPreview[]>;
}
interface StoredRehearsal {
  eventId: string;
  eventVersion: number;
  templateId: string;
  templateVersion: number;
  templateDigest: string;
  templateSnapshot: unknown;
  title: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
}
const columns = `r.event_id AS "eventId",r.event_version AS "eventVersion",
 r.template_id AS "templateId",r.template_version AS "templateVersion",
 r.template_digest AS "templateDigest",r.template_snapshot AS "templateSnapshot",
 i.title,i.starts_at AS "startsAt",i.ends_at AS "endsAt",i.capacity`;
const source = `private_event_rehearsals r JOIN private_event_inventory i USING(event_id,event_version)`;

/** Every consumer uses the same trusted exact snapshot. The caller owns the
 * bounded transaction and authority; this reader neither connects nor writes. */
export function eventCatalogReader(
  staticEvents: readonly EventPreview[] = EVENT_PREVIEWS,
): EventCatalogReader {
  const unavailable = () => Error("Private rehearsal catalog unavailable.");
  const acceptsReference = (id: string, version: number) =>
    staticEvents.some(
      (event) => event.id === id && event.version === version,
    ) ||
    (version === 1 &&
      /^local-rehearsal-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        id,
      ));
  function decode(row: StoredRehearsal): EventPreview {
    if (
      !/^local-rehearsal-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        row.eventId,
      ) ||
      row.eventVersion !== 1 ||
      !(row.startsAt instanceof Date) ||
      !Number.isFinite(+row.startsAt) ||
      !(row.endsAt instanceof Date) ||
      !Number.isFinite(+row.endsAt) ||
      !isDeepStrictEqual(row.templateSnapshot, REHEARSAL_TEMPLATE)
    )
      throw unavailable();
    const snapshot = rehearsalSnapshot({
      templateId: row.templateId,
      templateVersion: row.templateVersion,
      startsAt: row.startsAt.toISOString(),
    });
    if (
      !snapshot ||
      snapshot.title !== row.title ||
      snapshot.endsAt !== row.endsAt.toISOString() ||
      snapshot.capacity !== row.capacity ||
      snapshot.templateDigest !== row.templateDigest
    )
      throw unavailable();
    return {
      ...structuredClone(REHEARSAL_TEMPLATE),
      id: row.eventId,
      version: row.eventVersion,
      startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt,
    };
  }
  return {
    acceptsReference,
    async find(query, id, version) {
      if (!id.startsWith("local-rehearsal-")) {
        const event = staticEvents.find(
          (event) => event.id === id && event.version === version,
        );
        return event ? structuredClone(event) : undefined;
      }
      const rows = (
        await query.query<StoredRehearsal>(
          `SELECT ${columns} FROM ${source} WHERE r.event_id=$1 AND r.event_version=$2`,
          [id, version],
        )
      ).rows;
      return rows[0] ? decode(rows[0]) : undefined;
    },
    async list(query) {
      const rows = (
        await query.query<StoredRehearsal>(
          `SELECT ${columns} FROM ${source}
           WHERE i.starts_at>clock_timestamp() AND NOT EXISTS(
            SELECT 1 FROM private_event_cancellations c
            WHERE c.event_id=r.event_id AND c.event_version=r.event_version)
           ORDER BY i.starts_at,r.event_id LIMIT 21`,
        )
      ).rows;
      if (rows.length > 20) throw unavailable();
      return [
        ...staticEvents.map((event) => structuredClone(event)),
        ...rows.map(decode),
      ];
    },
  };
}
