import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { studyAllowanceLedgerOnConnection } from "./ledger.ts";
import {
  studyFixtureActors,
  studyFixtureConflict,
  studyFixtureExecute,
  studyFixtureWorkspace,
  type StudyFixtureContext,
} from "./study-unit-fixture-transaction.ts";
import {
  studyFixtureCreation,
  studyFixtureLocal,
  type StudyFixtureOptions,
} from "./study-unit-fixture-values.ts";
import {
  studyAllowanceInstruction,
  studyAllowanceKey,
  studyAllowanceLedgerKey,
  studyAllowancePeriod,
  type StudyAllowanceClaim,
  type StudyAllowancePolicy,
} from "./study-allowance-values.ts";

const policyColumns = `version,category,period_limit AS "periodLimit",period,eligibility,
 grant_source AS "grantSource",rate_estimate_version AS "rateEstimateVersion",spend_state AS "spendState"`;
const claimSelect = `SELECT c.id,c.policy_version AS "policyVersion",c.quantity,
 c.period_start AS "periodStart",c.period_end AS "periodEnd",c.created_at AS "createdAt",
 g.available,g.reserved,g.consumed,g.expired
 FROM study_allowance_claims c JOIN synthetic_entitlement_grants g ON g.id=c.grant_id`;

async function currentPolicy(context: StudyFixtureContext) {
  return (
    (
      await context.tx.query<StudyAllowancePolicy>(
        `SELECT ${policyColumns} FROM study_allowance_policies
         WHERE effective_from<=clock_timestamp() ORDER BY effective_from DESC,version DESC LIMIT 1`,
      )
    ).rows[0] ?? null
  );
}
async function claimWhere(
  context: StudyFixtureContext,
  condition: string,
  value: unknown,
) {
  return (
    (
      await context.tx.query<StudyAllowanceClaim>(
        `${claimSelect} WHERE c.member_id=$1 AND ${condition}`,
        [context.actorId, value],
      )
    ).rows[0] ?? null
  );
}
const periodClaim = (context: StudyFixtureContext, start: Date) =>
  claimWhere(
    context,
    "c.category='study_requests' AND c.period_start=$2",
    start,
  );

export function studyAllowanceStore(pool: Pool, supplied: StudyFixtureOptions) {
  const options = Object.freeze({ ...supplied });
  return {
    async member(token: string) {
      if (!studyFixtureLocal(options)) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        await studyFixtureActors(context, [], "member");
        await studyFixtureWorkspace(context, context.actorId);
        const observed = await context.tx.observe(context.expires);
        const period = studyAllowancePeriod(observed);
        return {
          policy: await currentPolicy(context),
          period,
          claim: await periodClaim(context, period.start),
          creationEnabled: studyFixtureCreation(options),
        };
      });
    },
    // The workspace row and slot lock serialize one member's claims, so the
    // key, slot and policy checks below all observe the committed outcome.
    async claim(token: string, key: string, input: unknown) {
      const checked = studyAllowanceInstruction(input);
      if (!studyAllowanceKey(key) || !checked)
        return { kind: "invalid" as const };
      if (!studyFixtureCreation(options)) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, true, async (context) => {
        await studyFixtureActors(context, [], "member");
        const workspaceId = await studyFixtureWorkspace(
          context,
          context.actorId,
        );
        const original = await claimWhere(context, "c.operation_key=$2", key);
        if (original) {
          if (
            original.policyVersion !== checked.policyVersion ||
            original.periodStart.toISOString() !== checked.periodStart
          )
            return studyFixtureConflict();
          return original;
        }
        const observed = await context.tx.observe(context.expires);
        const period = studyAllowancePeriod(observed);
        if (period.start.toISOString() !== checked.periodStart)
          return studyFixtureConflict();
        const existing = await periodClaim(context, period.start);
        if (existing) return existing;
        const policy = await currentPolicy(context);
        if (policy?.version !== checked.policyVersion)
          return studyFixtureConflict();
        const grantId = await studyAllowanceLedgerOnConnection(
          context.tx,
        ).grant(
          context.actorId,
          policy.periodLimit,
          studyAllowanceLedgerKey(context.actorId, period.start),
          {
            startsAt: observed.toISOString(),
            expiresAt: period.end.toISOString(),
          },
        );
        await context.tx.query(
          `INSERT INTO study_allowance_claims(id,member_id,workspace_id,policy_version,category,
           period_start,period_end,quantity,grant_id,operation_key)
           VALUES($1,$2,$3,$4,'study_requests',$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            context.actorId,
            workspaceId,
            policy.version,
            period.start,
            period.end,
            policy.periodLimit,
            grantId,
            key,
          ],
        );
        return (await periodClaim(context, period.start))!;
      });
    },
  };
}
export type StudyAllowanceStore = ReturnType<typeof studyAllowanceStore>;
