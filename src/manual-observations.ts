import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const syntheticReference = /^SYN-[A-Z0-9-]{6,64}$/;

export interface ManualObservationInput {
  memberId: string;
  idempotencyKey: string;
  evidenceReference: string;
  amountCents: number;
}

export interface ManualObservation extends ManualObservationInput {
  id: string;
  actorId: string;
  status: "unverified_manual";
  createdAt: Date;
}

export type ManualObservationResult =
  | { kind: "created" | "replayed"; observation: ManualObservation }
  | { kind: "denied" | "invalid" | "member_missing" | "conflict" };

export interface ManualObservationStore {
  list(token: string): Promise<ManualObservation[] | null>;
  record(
    token: string,
    input: ManualObservationInput,
  ): Promise<ManualObservationResult>;
}

export function parseManualObservation(
  value: unknown,
): ManualObservationInput | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  const amount = fields.amountCents;
  if (
    fields.confirm !== "yes" ||
    typeof fields.memberId !== "string" ||
    !uuid.test(fields.memberId) ||
    typeof fields.idempotencyKey !== "string" ||
    !uuid.test(fields.idempotencyKey) ||
    typeof fields.evidenceReference !== "string" ||
    !syntheticReference.test(fields.evidenceReference) ||
    typeof amount !== "string" ||
    !/^[1-9][0-9]*$/.test(amount)
  )
    return null;
  const amountCents = Number(amount);
  if (!Number.isSafeInteger(amountCents) || amountCents > 10_000_000)
    return null;
  return {
    memberId: fields.memberId,
    idempotencyKey: fields.idempotencyKey,
    evidenceReference: fields.evidenceReference,
    amountCents,
  };
}

export function disabledManualObservationStore(): ManualObservationStore {
  return {
    list: async () => null,
    record: async () => ({ kind: "denied" }),
  };
}

const columns = `o.id,o.member_id AS "memberId",o.actor_id AS "actorId",
  o.idempotency_key AS "idempotencyKey",
  o.evidence_reference AS "evidenceReference",
  o.amount_cents AS "amountCents",o.status,o.created_at AS "createdAt"`;

export function manualObservationStore(pool: Pool): ManualObservationStore {
  return {
    async list(token) {
      const rows = (
        await pool.query<ManualObservation & { authorized: string }>(
          `WITH authorized AS MATERIALIZED (
             SELECT p.id FROM principals p JOIN staff_profiles s
               ON s.principal_id=p.id AND s.role='platform_admin'
             WHERE p.token_hash=$1 AND p.kind='staff'
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
             FOR SHARE OF p,s
           )
           SELECT a.id AS authorized,${columns}
           FROM authorized a LEFT JOIN synthetic_manual_observations o ON TRUE
           ORDER BY o.created_at DESC,o.id DESC LIMIT 101`,
          [hash(token)],
        )
      ).rows;
      if (!rows.length) return null;
      return rows.filter((row) => row.id !== null).slice(0, 100);
    },
    async record(token, input) {
      if (
        !parseManualObservation({
          ...input,
          amountCents: String(input.amountCents),
          confirm: "yes",
        })
      )
        return { kind: "invalid" };
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            input.memberId,
            input.evidenceReference,
            input.amountCents,
          ]),
        )
        .digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const actor = (
          await client.query<{ id: string }>(
            `SELECT p.id FROM principals p JOIN staff_profiles s
               ON s.principal_id=p.id AND s.role='platform_admin'
             WHERE p.token_hash=$1 AND p.kind='staff'
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
             FOR SHARE OF p,s`,
            [hash(token)],
          )
        ).rows[0];
        if (!actor) return { kind: "denied" };
        const member = (
          await client.query<{ id: string }>(
            "SELECT id FROM learners WHERE id=$1 FOR SHARE",
            [input.memberId],
          )
        ).rows[0];
        if (!member) return { kind: "member_missing" };
        const created = (
          await client.query<ManualObservation>(
            `INSERT INTO synthetic_manual_observations AS o
             (id,member_id,actor_id,idempotency_key,evidence_reference,
              amount_cents,request_fingerprint)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(idempotency_key) DO NOTHING
             RETURNING ${columns}`,
            [
              randomUUID(),
              member.id,
              actor.id,
              input.idempotencyKey,
              input.evidenceReference,
              input.amountCents,
              fingerprint,
            ],
          )
        ).rows[0];
        if (created) {
          await client.query("COMMIT");
          return { kind: "created", observation: created };
        }
        const previous = (
          await client.query<
            ManualObservation & { requestFingerprint: string }
          >(
            `SELECT ${columns},o.request_fingerprint AS "requestFingerprint"
             FROM synthetic_manual_observations o WHERE o.idempotency_key=$1`,
            [input.idempotencyKey],
          )
        ).rows[0];
        if (
          !previous ||
          previous.actorId !== actor.id ||
          previous.requestFingerprint !== fingerprint
        )
          return { kind: "conflict" };
        const observation: ManualObservation = {
          id: previous.id,
          memberId: previous.memberId,
          actorId: previous.actorId,
          idempotencyKey: previous.idempotencyKey,
          evidenceReference: previous.evidenceReference,
          amountCents: previous.amountCents,
          status: previous.status,
          createdAt: previous.createdAt,
        };
        await client.query("COMMIT");
        return { kind: "replayed", observation };
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    },
  };
}
