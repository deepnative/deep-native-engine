import type { Pool } from "pg";
import { hash } from "./store.ts";
import { EventCancellationFailure } from "./event-cancellation-lifetime.ts";
import {
  attendanceId,
  attendanceRemovalChecked,
  type AttendanceRemovalChecked,
} from "./event-attendance-values.ts";
import {
  attendanceActors,
  attendanceDeny,
  attendanceExecute,
  attendanceSource,
  type AttendanceContext,
} from "./event-attendance-transaction.ts";
import {
  attendanceLocal,
  type AttendanceOptions,
} from "./event-attendance-reader.ts";

async function ownedObservation(
  context: AttendanceContext,
  observationId: string,
) {
  const locator = (
    await context.tx.query<{ registrationId: string; permissionId: string }>(
      `SELECT registration_id AS "registrationId",permission_id AS "permissionId"
     FROM private_event_attendance_observations WHERE id=$1 AND member_id=$2`,
      [observationId, context.actorId],
    )
  ).rows[0];
  if (!locator) return attendanceDeny();
  const source = await attendanceSource(
    context,
    locator.registrationId,
    context.actorId,
  );
  await context.tx.query(
    "SELECT id FROM private_event_attendance_permissions WHERE registration_id=$1 AND member_id=$2 ORDER BY id FOR UPDATE",
    [source.registrationId, context.actorId],
  );
  const observation = (
    await context.tx.query<{ id: string }>(
      `SELECT id FROM private_event_attendance_observations WHERE id=$1 AND registration_id=$2 AND permission_id=$3
     AND member_id=$4 AND workspace_id=$5 FOR UPDATE`,
      [
        observationId,
        source.registrationId,
        locator.permissionId,
        context.actorId,
        source.workspaceId,
      ],
    )
  ).rows[0];
  if (!observation) return attendanceDeny();
  return source;
}
export async function attendanceRemovalCheck(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  observationId: string,
) {
  if (!attendanceId(observationId)) return { kind: "invalid" as const };
  if (!attendanceLocal(options)) return { kind: "denied" as const };
  return attendanceExecute(
    pool,
    token,
    false,
    async (context): Promise<AttendanceRemovalChecked> => {
      await attendanceActors(context, [], "member");
      const source = await ownedObservation(context, observationId);
      return { registrationId: source.registrationId, observationId };
    },
  );
}
export async function attendanceRemove(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  key: string,
  input: unknown,
) {
  const checked = attendanceRemovalChecked(input);
  if (!checked || !attendanceId(key)) return { kind: "invalid" as const };
  if (!attendanceLocal(options)) return { kind: "denied" as const };
  return attendanceExecute(pool, token, true, async (context) => {
    await attendanceActors(context, [], "member");
    const source = await attendanceSource(
      context,
      checked.registrationId,
      context.actorId,
    );
    // All identifying permission links are removed together with this exact
    // observation. Old keys remain reserved; they cannot recreate the fact.
    await context.tx.query(
      "SELECT id FROM private_event_attendance_permissions WHERE registration_id=$1 AND member_id=$2 ORDER BY id FOR UPDATE",
      [source.registrationId, context.actorId],
    );
    const observation = (
      await context.tx.query<{ id: string }>(
        "SELECT id FROM private_event_attendance_observations WHERE registration_id=$1 AND member_id=$2 AND workspace_id=$3 FOR UPDATE",
        [source.registrationId, context.actorId, source.workspaceId],
      )
    ).rows[0];
    await context.tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [key],
    );
    const operation = (
      await context.tx.query<{
        actorId: string | null;
        registrationId: string | null;
        kind: string | null;
        instructionHash: string | null;
      }>(
        `SELECT actor_id AS "actorId",registration_id AS "registrationId",kind,instruction_hash AS "instructionHash"
       FROM private_event_attendance_operations WHERE operation_id=$1 FOR UPDATE`,
        [key],
      )
    ).rows[0];
    const instructionHash = hash(JSON.stringify(checked));
    if (operation) {
      if (
        operation.actorId !== context.actorId ||
        operation.registrationId !== source.registrationId ||
        operation.kind !== "remove" ||
        operation.instructionHash !== instructionHash
      )
        throw new EventCancellationFailure("conflict");
      return {
        kind: "remove" as const,
        registrationId: source.registrationId,
        removed: true as const,
      };
    }
    if (!observation || observation.id !== checked.observationId)
      return attendanceDeny();
    await context.tx.query(
      "DELETE FROM private_event_attendance_permissions WHERE registration_id=$1 AND member_id=$2 AND workspace_id=$3",
      [source.registrationId, context.actorId, source.workspaceId],
    );
    await context.tx.query(
      `INSERT INTO private_event_attendance_operations(operation_id,actor_id,workspace_id,registration_id,kind,instruction_hash)
       VALUES($1,$2,$3,$4,'remove',$5)`,
      [
        key,
        context.actorId,
        source.workspaceId,
        source.registrationId,
        instructionHash,
      ],
    );
    return {
      kind: "remove" as const,
      registrationId: source.registrationId,
      removed: true as const,
    };
  });
}
