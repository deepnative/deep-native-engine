import type { Pool } from "pg";
import { hash } from "./store.ts";
import { EventCancellationFailure } from "./event-cancellation-lifetime.ts";
import type { EventCancellationResult } from "./event-cancellation-values.ts";
import {
  attendanceChecked,
  attendanceId,
  attendanceObservationChecked,
  attendanceRemovalChecked,
  type AttendanceOperationKind,
  type AttendanceObservation,
  type AttendanceSavedReceipt,
} from "./event-attendance-values.ts";
import {
  attendanceActors,
  attendanceDeny,
  attendanceExecute,
  attendanceSource,
} from "./event-attendance-transaction.ts";
import {
  attendanceLocal,
  type AttendanceOptions,
} from "./event-attendance-reader.ts";
import { attendanceProtectedPermission } from "./event-attendance-observations.ts";
import { attendanceOwnedPermission } from "./event-attendance-permissions.ts";

function instruction(kind: AttendanceOperationKind, input: unknown) {
  if (kind === "permit") {
    const checked = attendanceChecked(input);
    return checked ? ({ kind, checked } as const) : null;
  }
  if (kind === "observe") {
    const checked = attendanceObservationChecked(input);
    return checked ? ({ kind, checked } as const) : null;
  }
  if (kind === "remove") {
    const checked = attendanceRemovalChecked(input);
    return checked ? ({ kind, checked } as const) : null;
  }
  if (
    kind === "withdraw" &&
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    "permissionId" in input &&
    attendanceId(input.permissionId)
  )
    return { kind, checked: { permissionId: input.permissionId } } as const;
  return null;
}
interface Operation {
  actorId: string | null;
  workspaceId: string | null;
  registrationId: string | null;
  kind: string | null;
  instructionHash: string | null;
  permissionId: string | null;
  observationId: string | null;
}
const columns = `actor_id AS "actorId",workspace_id AS "workspaceId",registration_id AS "registrationId",kind,
  instruction_hash AS "instructionHash",permission_id AS "permissionId",observation_id AS "observationId"`;

/** Inspect only. This never calls a mutation, creates a key or renews a grant.
 * A missing receipt cannot promise that a previously uncertain write won't
 * later finish; all private reads still require fresh current authority. */
export async function attendanceInspect(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  key: string,
  kind: AttendanceOperationKind,
  input: unknown,
): Promise<EventCancellationResult<AttendanceSavedReceipt | null>> {
  const parsed = instruction(kind, input);
  if (!attendanceId(key) || !parsed) return { kind: "invalid" };
  if (!attendanceLocal(options)) return { kind: "denied" };
  return attendanceExecute(pool, token, false, async (context) => {
    // Operation discovery is not authority, and its metadata is never returned.
    const discovered = (
      await context.tx.query<Operation>(
        `SELECT ${columns} FROM private_event_attendance_operations WHERE operation_id=$1`,
        [key],
      )
    ).rows[0];
    let source;
    if (parsed.kind === "observe") {
      source = (
        await attendanceProtectedPermission(
          context,
          parsed.checked.permissionId,
        )
      ).source;
      if (source.registrationId !== parsed.checked.registrationId)
        return attendanceDeny();
    } else {
      await attendanceActors(context, [], "member");
      let registrationId: string | undefined;
      if (parsed.kind === "withdraw") {
        registrationId = (
          await context.tx.query<{ registrationId: string }>(
            `SELECT registration_id AS "registrationId" FROM private_event_attendance_permissions WHERE id=$1 AND member_id=$2`,
            [parsed.checked.permissionId, context.actorId],
          )
        ).rows[0]?.registrationId;
        if (
          !registrationId &&
          discovered?.actorId === context.actorId &&
          discovered.kind === "withdraw"
        )
          registrationId = discovered.registrationId ?? undefined;
      } else registrationId = parsed.checked.registrationId;
      if (!registrationId) return attendanceDeny();
      source = await attendanceSource(context, registrationId, context.actorId);
    }
    const ownedPermission =
      parsed.kind !== "observe" &&
      discovered?.actorId === context.actorId &&
      discovered.registrationId === source.registrationId &&
      discovered.permissionId
        ? await attendanceOwnedPermission(
            context,
            source,
            discovered.permissionId,
          )
        : null;
    const observation =
      parsed.kind === "observe"
        ? (
            await context.tx.query<Omit<AttendanceObservation, "attribution">>(
              `SELECT id,permission_id AS "permissionId",registration_id AS "registrationId",recorded_at AS "recordedAt"
       FROM private_event_attendance_observations WHERE registration_id=$1 AND member_id=$2 AND workspace_id=$3 FOR UPDATE`,
              [source.registrationId, source.memberId, source.workspaceId],
            )
          ).rows[0]
        : null;
    await context.tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [key],
    );
    const saved = (
      await context.tx.query<Operation>(
        `SELECT ${columns} FROM private_event_attendance_operations WHERE operation_id=$1 FOR UPDATE`,
        [key],
      )
    ).rows[0];
    if (!saved) return null;
    if (
      saved.actorId !== context.actorId ||
      saved.workspaceId !== source.workspaceId ||
      saved.registrationId !== source.registrationId ||
      saved.kind !== parsed.kind ||
      saved.instructionHash !== hash(JSON.stringify(parsed.checked))
    )
      throw new EventCancellationFailure("conflict");
    if (parsed.kind === "remove")
      return {
        kind: "remove",
        registrationId: source.registrationId,
        removed: true,
      };
    if (parsed.kind === "observe") {
      if (
        !observation ||
        saved.observationId !== observation.id ||
        saved.permissionId !== parsed.checked.permissionId ||
        observation.permissionId !== parsed.checked.permissionId
      )
        throw new EventCancellationFailure("conflict");
      return {
        kind: "observe",
        observation: {
          ...observation,
          attribution: "Local platform administrator",
        },
      };
    }
    if (!ownedPermission || saved.permissionId !== ownedPermission.id)
      throw new EventCancellationFailure("conflict");
    return { kind: parsed.kind, permission: ownedPermission };
  });
}
