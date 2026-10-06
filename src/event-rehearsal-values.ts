import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EVENT_PREVIEWS } from "./events.ts";
import type { EventCancellationResult } from "./event-cancellation-values.ts";

// This template is shipped and schema-checked with the repository. Scheduling
// changes its dates, never its published reference or trusted learning content.
export const REHEARSAL_TEMPLATE = EVENT_PREVIEWS.find(
  (event) => event.id === "local-registration-rehearsal" && event.version === 1,
)!;
export interface RehearsalInstruction {
  templateId: string;
  templateVersion: number;
  startsAt: string;
}
export interface RehearsalSnapshot extends RehearsalInstruction {
  title: string;
  endsAt: string;
  capacity: number;
  templateDigest: string;
}
export interface RehearsalReceipt {
  id: string;
  eventId: string;
  eventVersion: number;
  title: string;
  startsAt: Date;
  endsAt: Date;
  scheduledAt: Date;
}
export interface EventRehearsalStore {
  admin(
    token: string,
  ): Promise<EventCancellationResult<{ creationEnabled: boolean }>>;
  preview(
    token: string,
    instruction: unknown,
  ): Promise<
    EventCancellationResult<{
      snapshot: RehearsalSnapshot;
      creationEnabled: boolean;
    }>
  >;
  schedule(
    token: string,
    key: string,
    snapshot: unknown,
  ): Promise<
    EventCancellationResult<{
      receipt: RehearsalReceipt;
      replayed: boolean;
    }>
  >;
  inspectOperation(
    token: string,
    key: string,
    snapshot: unknown,
  ): Promise<EventCancellationResult<RehearsalReceipt | null>>;
  receipt(
    token: string,
    id: string,
  ): Promise<EventCancellationResult<RehearsalReceipt | null>>;
}

/** Strict user input; admissible scheduling time is subsequently checked against
 * PostgreSQL's clock inside the authority-owning transaction. */
export function rehearsalInstruction(
  value: unknown,
): RehearsalInstruction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 3 ||
    !Object.keys(fields).every((key) =>
      ["templateId", "templateVersion", "startsAt"].includes(key),
    ) ||
    fields.templateId !== REHEARSAL_TEMPLATE.id ||
    fields.templateVersion !== REHEARSAL_TEMPLATE.version ||
    typeof fields.startsAt !== "string" ||
    fields.startsAt.length !== 24
  )
    return null;
  const instant = new Date(fields.startsAt);
  if (!Number.isFinite(+instant) || instant.toISOString() !== fields.startsAt)
    return null;
  return {
    templateId: REHEARSAL_TEMPLATE.id,
    templateVersion: REHEARSAL_TEMPLATE.version,
    startsAt: fields.startsAt,
  };
}

export function rehearsalSnapshot(value: unknown): RehearsalSnapshot | null {
  const instruction = rehearsalInstruction(value);
  if (!instruction) return null;
  const duration =
    +new Date(REHEARSAL_TEMPLATE.endsAt) -
    +new Date(REHEARSAL_TEMPLATE.startsAt);
  return {
    ...instruction,
    title: REHEARSAL_TEMPLATE.title,
    endsAt: new Date(+new Date(instruction.startsAt) + duration).toISOString(),
    capacity: REHEARSAL_TEMPLATE.fixtureCapacity,
    templateDigest: createHash("sha256")
      .update(JSON.stringify(REHEARSAL_TEMPLATE))
      .digest("hex"),
  };
}

/** A checked instruction cannot substitute different trusted content, dates,
 * capacity or provenance during confirmation or historical recovery. */
export function checkedRehearsalSnapshot(
  value: unknown,
): RehearsalSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const snapshot = rehearsalSnapshot({
    templateId: fields.templateId,
    templateVersion: fields.templateVersion,
    startsAt: fields.startsAt,
  });
  return snapshot && isDeepStrictEqual(value, snapshot) ? snapshot : null;
}
