import type { Pool } from "pg";
import { workflowReviewCursor } from "./workflow-review-cursor.ts";
import {
  attendanceActors,
  attendanceDeny,
  attendanceExecute,
  attendanceSource,
} from "./event-attendance-transaction.ts";
import {
  attendanceLocal,
  attendanceReadOwned,
  type AttendanceOptions,
} from "./event-attendance-reader.ts";
import type { AttendanceMemberView } from "./event-attendance-values.ts";

export async function attendanceHistory(
  pool: Pool,
  options: AttendanceOptions,
  secret: string,
  token: string,
  cursor?: string,
) {
  if (!attendanceLocal(options)) return { kind: "denied" as const };
  const codec = workflowReviewCursor(secret, "attendance-history");
  const after = cursor === undefined ? null : codec.read(cursor);
  if (cursor !== undefined && !after) return { kind: "invalid" as const };
  return attendanceExecute(pool, token, false, async (context) => {
    await attendanceActors(context, [], "member");
    if (after && after.actorId !== context.actorId) return attendanceDeny();
    const workspace = (
      await context.tx.query<{ id: string }>(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR UPDATE",
        [context.actorId],
      )
    ).rows[0];
    if (!workspace) return attendanceDeny();
    if (
      after &&
      !(
        await context.tx.query(
          "SELECT id FROM private_event_enrollments WHERE id=$1 AND member_id=$2 AND workspace_id=$3 AND created_at=$4::timestamptz",
          [after.id, context.actorId, workspace.id, after.createdAt],
        )
      ).rows.length
    )
      return attendanceDeny();
    const rows = (
      await context.tx.query<{ id: string; createdAt: string }>(
        `SELECT e.id,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
       FROM private_event_enrollments e WHERE e.member_id=$1 AND e.workspace_id=$2
       AND ($3::timestamptz IS NULL OR (e.created_at,e.id)>($3::timestamptz,$4::uuid))
       AND (EXISTS(SELECT 1 FROM private_event_attendance_permissions p WHERE p.registration_id=e.id AND p.member_id=e.member_id AND p.workspace_id=e.workspace_id)
        OR EXISTS(SELECT 1 FROM private_event_attendance_observations o WHERE o.registration_id=e.id AND o.member_id=e.member_id AND o.workspace_id=e.workspace_id))
       ORDER BY e.created_at,e.id LIMIT 21`,
        [
          context.actorId,
          workspace.id,
          after?.createdAt ?? null,
          after?.id ?? null,
        ],
      )
    ).rows;
    const items: AttendanceMemberView[] = [];
    for (const row of rows.slice(0, 20)) {
      const source = await attendanceSource(context, row.id, context.actorId);
      items.push(await attendanceReadOwned(context, source, options));
    }
    const last = rows[Math.min(rows.length, 20) - 1];
    return {
      items,
      nextCursor:
        rows.length > 20 && last
          ? codec.sign({
              actorId: context.actorId,
              createdAt: last.createdAt,
              id: last.id,
            })
          : null,
    };
  });
}
