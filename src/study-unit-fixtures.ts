import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { studyFixtureLedgerOnConnection } from "./ledger.ts";
import {
  STUDY_FIXTURE_POLICY,
  STUDY_REQUEST_WINDOW,
  STUDY_GRANT_WINDOW,
  studyFixtureCreation,
  studyFixtureLocal,
  studyFixtureId,
  studyRequestInstruction,
  studyIssueInstruction,
  type StudyFixtureOptions,
  type StudyIssueInstruction,
} from "./study-unit-fixture-values.ts";
import {
  studyFixtureActors,
  studyFixtureConflict,
  studyFixtureDeny,
  studyFixtureExecute,
  studyFixtureWorkspace,
  studyFixtureOwned,
  studyFixtureExact,
  studyFixtureReceipt,
  studyFixtureOperation,
  studyFixtureReserveOperation,
  type StudyFixtureContext,
} from "./study-unit-fixture-transaction.ts";

async function selectedAdministrator(
  context: StudyFixtureContext,
  administratorId: string,
) {
  const actors = await studyFixtureActors(context, [administratorId], "member");
  const administrator = actors.principals.get(administratorId);
  if (
    !administrator ||
    administrator.kind !== "staff" ||
    administrator.revoked !== null ||
    actors.profiles.get(administratorId) !== "platform_admin"
  )
    return studyFixtureDeny();
  context.expires.push(administrator.expires);
  await context.tx.observe(context.expires);
  return { member: actors.principals.get(context.actorId)!, administrator };
}
async function staffSource(context: StudyFixtureContext, requestId: string) {
  // Locate before locking the complete sorted actor set. The locator grants no
  // authority, and the exact retained source is re-read under its workspace.
  const locator = (
    await context.tx.query<{
      memberId: string;
      administratorId: string | null;
    }>(
      `SELECT member_id AS "memberId",administrator_id AS "administratorId"
       FROM browser_study_fixture_requests WHERE id=$1`,
      [requestId],
    )
  ).rows[0];
  if (!locator) return studyFixtureDeny();
  const actors = await studyFixtureActors(
    context,
    [
      locator.memberId,
      ...(locator.administratorId ? [locator.administratorId] : []),
    ],
    "platform_admin",
  );
  const member = actors.principals.get(locator.memberId);
  if (
    !member ||
    member.kind !== "member" ||
    member.revoked !== null ||
    locator.administratorId !== context.actorId
  )
    return studyFixtureDeny();
  context.expires.push(member.expires);
  const workspaceId = await studyFixtureWorkspace(context, member.id);
  const source = await studyFixtureExact(context, requestId, member.id);
  if (
    source.workspaceId !== workspaceId ||
    source.administratorId !== context.actorId
  )
    return studyFixtureDeny();
  context.expires.push(
    source.memberExpiresAt,
    source.administratorExpiresAt,
    source.expiresAt,
  );
  if (source.grantExpiresAt) context.expires.push(source.grantExpiresAt);
  await context.tx.observe(context.expires);
  return {
    source,
    member,
    administrator: actors.principals.get(context.actorId)!,
  };
}
export function studyUnitFixtureStore(
  pool: Pool,
  supplied: StudyFixtureOptions,
) {
  const options = Object.freeze({ ...supplied });
  const local = () => studyFixtureLocal(options);
  const creation = () => studyFixtureCreation(options);
  return {
    async member(token: string) {
      if (!local()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        await studyFixtureActors(context, [], "member");
        await studyFixtureWorkspace(context, context.actorId);
        const row = await studyFixtureOwned(context, context.actorId);
        return {
          receipt: row ? studyFixtureReceipt(row) : null,
          creationEnabled: creation(),
        };
      });
    },
    async administrator(token: string) {
      if (!local()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        await studyFixtureActors(context, [], "platform_admin");
        return { reference: context.actorId, creationEnabled: creation() };
      });
    },
    async checkRequest(token: string, administratorId: string) {
      if (!studyFixtureId(administratorId)) return { kind: "invalid" as const };
      if (!creation()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        const actors = await selectedAdministrator(context, administratorId);
        await studyFixtureWorkspace(context, context.actorId);
        if (await studyFixtureOwned(context, context.actorId))
          return studyFixtureConflict();
        const now = await context.tx.observe(context.expires);
        return {
          policy: STUDY_FIXTURE_POLICY,
          administratorId,
          memberExpiresAt: actors.member.expires.toISOString(),
          administratorExpiresAt: actors.administrator.expires.toISOString(),
          checkedAt: now.toISOString(),
          expiresAt: new Date(
            Math.min(
              +now + STUDY_REQUEST_WINDOW,
              +actors.member.expires,
              +actors.administrator.expires,
            ),
          ).toISOString(),
        };
      });
    },
    async request(token: string, key: string, input: unknown) {
      const checked = studyRequestInstruction(input);
      if (!studyFixtureId(key) || !checked) return { kind: "invalid" as const };
      if (!creation()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, true, async (context) => {
        const actors = await studyFixtureActors(
          context,
          [checked.administratorId],
          "member",
        );
        const workspaceId = await studyFixtureWorkspace(
          context,
          context.actorId,
        );
        const row = await studyFixtureOwned(context, context.actorId);
        const digest = hash(JSON.stringify(checked));
        const original = await studyFixtureOperation(
          context,
          workspaceId,
          key,
          "request",
          digest,
        );
        if (original)
          return studyFixtureReceipt(
            await studyFixtureExact(context, original, context.actorId),
          );
        if (row) return studyFixtureConflict();
        const member = actors.principals.get(context.actorId)!;
        const administrator = actors.principals.get(checked.administratorId);
        if (
          !administrator ||
          administrator.kind !== "staff" ||
          administrator.revoked !== null ||
          actors.profiles.get(administrator.id) !== "platform_admin" ||
          member.expires.toISOString() !== checked.memberExpiresAt ||
          administrator.expires.toISOString() !== checked.administratorExpiresAt
        )
          return studyFixtureDeny();
        context.expires.push(
          administrator.expires,
          new Date(checked.expiresAt),
        );
        const now = await context.tx.observe(context.expires);
        if (+new Date(checked.checkedAt) > +now) return studyFixtureDeny();
        const id = randomUUID();
        await context.tx.query(
          `INSERT INTO browser_study_fixture_requests(id,member_id,workspace_id,administrator_id,policy,
           member_expires_at,administrator_expires_at,checked_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            context.actorId,
            workspaceId,
            checked.administratorId,
            STUDY_FIXTURE_POLICY,
            checked.memberExpiresAt,
            checked.administratorExpiresAt,
            checked.checkedAt,
            checked.expiresAt,
          ],
        );
        await studyFixtureReserveOperation(
          context,
          workspaceId,
          key,
          "request",
          digest,
          id,
        );
        return studyFixtureReceipt(
          await studyFixtureExact(context, id, context.actorId),
        );
      });
    },
    async permission(token: string, requestId: string) {
      if (!local() || !studyFixtureId(requestId))
        return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        const { source } = await staffSource(context, requestId);
        return {
          receipt: studyFixtureReceipt(source),
          creationEnabled: creation(),
        };
      });
    },
    async checkIssue(token: string, requestId: string) {
      if (!studyFixtureId(requestId)) return { kind: "invalid" as const };
      if (!creation()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        const { source } = await staffSource(context, requestId);
        if (source.grantId || source.withdrawnAt) return studyFixtureDeny();
        const now = await context.tx.observe(context.expires);
        return {
          policy: STUDY_FIXTURE_POLICY,
          requestId,
          requestExpiresAt: source.expiresAt.toISOString(),
          checkedAt: now.toISOString(),
          expiresAt: new Date(
            Math.min(+now + STUDY_GRANT_WINDOW, ...context.expires.map(Number)),
          ).toISOString(),
        } satisfies StudyIssueInstruction;
      });
    },
    async issue(token: string, key: string, input: unknown) {
      const checked = studyIssueInstruction(input);
      if (!studyFixtureId(key) || !checked) return { kind: "invalid" as const };
      if (!creation()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, true, async (context) => {
        const { source, member, administrator } = await staffSource(
          context,
          checked.requestId,
        );
        const digest = hash(JSON.stringify(checked));
        const original = await studyFixtureOperation(
          context,
          source.workspaceId,
          key,
          "issue",
          digest,
          source.id,
        );
        if (original) return studyFixtureReceipt(source);
        if (source.grantId || source.withdrawnAt) return studyFixtureConflict();
        if (
          source.expiresAt.toISOString() !== checked.requestExpiresAt ||
          +new Date(checked.expiresAt) > +member.expires ||
          +new Date(checked.expiresAt) > +administrator.expires
        )
          return studyFixtureDeny();
        context.expires.push(new Date(checked.expiresAt));
        const now = await context.tx.observe(context.expires);
        if (+new Date(checked.checkedAt) > +now) return studyFixtureDeny();
        const grantId = await studyFixtureLedgerOnConnection(
          context.tx,
          source.id,
        ).grant(member.id, {
          startsAt: now.toISOString(),
          expiresAt: checked.expiresAt,
        });
        await context.tx.query(
          `UPDATE browser_study_fixture_requests SET grant_id=$2,issued_at=$3,grant_expires_at=$4 WHERE id=$1`,
          [source.id, grantId, now, checked.expiresAt],
        );
        await studyFixtureReserveOperation(
          context,
          source.workspaceId,
          key,
          "issue",
          digest,
          source.id,
        );
        return studyFixtureReceipt(
          await studyFixtureExact(context, source.id, member.id),
        );
      });
    },
    async withdraw(token: string, key: string, requestId: string) {
      if (!studyFixtureId(key) || !studyFixtureId(requestId))
        return { kind: "invalid" as const };
      if (!local()) return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, true, async (context) => {
        await studyFixtureActors(context, [], "member");
        const workspaceId = await studyFixtureWorkspace(
          context,
          context.actorId,
        );
        const source = await studyFixtureExact(
          context,
          requestId,
          context.actorId,
        );
        const digest = hash(JSON.stringify({ requestId }));
        const original = await studyFixtureOperation(
          context,
          workspaceId,
          key,
          "withdraw",
          digest,
          source.id,
        );
        if (original) return studyFixtureReceipt(source);
        if (source.withdrawnAt) return studyFixtureConflict();
        await context.tx.query(
          "UPDATE browser_study_fixture_requests SET withdrawn_at=clock_timestamp() WHERE id=$1",
          [source.id],
        );
        if (source.grantId)
          await studyFixtureLedgerOnConnection(context.tx, source.id).withdraw(
            context.actorId,
            source.grantId,
          );
        await studyFixtureReserveOperation(
          context,
          workspaceId,
          key,
          "withdraw",
          digest,
          source.id,
        );
        return studyFixtureReceipt(
          await studyFixtureExact(context, source.id, context.actorId),
        );
      });
    },
    async inspect(
      token: string,
      key: string,
      kind: "request" | "issue" | "withdraw",
      input: unknown,
    ) {
      const checked =
        kind === "request"
          ? studyRequestInstruction(input)
          : kind === "issue"
            ? studyIssueInstruction(input)
            : typeof input === "string" && studyFixtureId(input)
              ? { requestId: input }
              : null;
      if (!local() || !studyFixtureId(key) || !checked)
        return { kind: "denied" as const };
      return studyFixtureExecute(pool, token, false, async (context) => {
        const source =
          kind === "issue"
            ? (
                await staffSource(
                  context,
                  (checked as StudyIssueInstruction).requestId,
                )
              ).source
            : await (async () => {
                await studyFixtureActors(context, [], "member");
                await studyFixtureWorkspace(context, context.actorId);
                return studyFixtureOwned(context, context.actorId);
              })();
        if (!source) return null;
        const original = await studyFixtureOperation(
          context,
          source.workspaceId,
          key,
          kind,
          hash(JSON.stringify(checked)),
          source.id,
        );
        return original ? studyFixtureReceipt(source) : null;
      });
    },
  };
}
export type StudyUnitFixtureStore = ReturnType<typeof studyUnitFixtureStore>;
