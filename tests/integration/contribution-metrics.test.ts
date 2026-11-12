import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { hash, migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { proposalStore } from "../../src/proposals.ts";
import {
  publicationStore,
  DISPLAY_PERMISSION,
  type PublicationResult,
} from "../../src/proposal-publication.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { metricsStore } from "../../src/metrics.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool),
  metrics = metricsStore(pool);
const proposals = proposalStore(pool, undefined, { ordinaryEnabled: true }),
  publications = publicationStore(pool, { enabled: true });
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());

const token = () => randomBytes(32).toString("hex");
const value = (n = 0) => ({
  title: `Invented member method ${n}`,
  body: "Original invented text with two source checks.",
  sources: "Original fixture text only.",
});
function ready<T>(result: PublicationResult<T>): T {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error(result.kind);
  return result.value;
}
async function staff(role: "moderator" | "platform_admin" | "operator") {
  const value = token();
  const id = await auth.provisionStaff(
    value,
    role,
    new Date(Date.now() + 3600000),
  );
  return { token: value, id };
}
async function member(
  background: "explorer" | "professional" | "technical" = "explorer",
) {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  if (session.kind !== "active") throw Error("Member fixture absent");
  return { token: value, id: session.learner.id };
}
async function submitted(owner: string, n = 0, sample = false) {
  const store = sample ? proposalStore(pool) : proposals;
  const id = (await store.createDraft(owner, value(n), sample))!;
  expect(await store.submit(owner, id, true, 1)).toBe("submitted");
  return id;
}
const publish = (owner: string, proposalId: string, revision = 1) =>
  publications.publish(owner, {
    operationId: randomUUID(),
    proposalId,
    revision,
    attribution: "Invented pseudonym",
    audience: "members",
    permissionVersion: DISPLAY_PERMISSION,
    confirmed: true,
  });
async function events(proposalId?: string) {
  return (
    await pool.query(
      `SELECT revision,kind,outcome,cause,actor_authority AS actor,origin,permission_version AS permission,source_table AS source
       FROM contribution_events WHERE ($1::uuid IS NULL OR proposal_id=$1) ORDER BY id`,
      [proposalId ?? null],
    )
  ).rows;
}

it("CM122-01 records each committed transition once for three audiences and ignores drafts, reads and quarantine", async () => {
  const moderator = await staff("moderator"),
    admin = await staff("platform_admin");
  const owners = await Promise.all(
    (["explorer", "professional", "technical"] as const).map(member),
  );
  const draft = (await proposals.createDraft(
    owners[0]!.token,
    value(9),
    false,
  ))!;
  const [changes, rejected, accepted] = await Promise.all(
    owners.map((o, n) => submitted(o.token, n)),
  );
  expect(await proposals.moderationQueue(moderator.token)).toHaveLength(3);
  expect(
    await proposals.moderate(moderator.token, rejected!, "quarantine"),
  ).toBe(true);
  expect(
    await proposals.requestChanges(moderator.token, changes!, {
      expectedRevision: 1,
      feedback: "Please add one invented check.",
    }),
  ).toBe("requested");
  expect(await proposals.moderate(admin.token, rejected!, "reject")).toBe(true);
  ready(await publications.accept(moderator.token, accepted!, 1, true));
  ready(await publications.accept(moderator.token, accepted!, 1, true));
  ready(await publish(owners[2]!.token, accepted!));
  expect(await proposals.submit(owners[2]!.token, accepted!, true, 1)).toBe(
    "replayed",
  );

  expect(await events(draft)).toEqual([]);
  const base = { revision: 1, cause: null, origin: "member", permission: null };
  expect(await events(changes)).toEqual([
    {
      ...base,
      kind: "submitted",
      outcome: null,
      actor: "member",
      source: "member_proposals",
    },
    {
      ...base,
      kind: "reviewed",
      outcome: "changes_requested",
      actor: "moderator",
      source: "member_proposals",
    },
  ]);
  expect(await events(rejected)).toEqual([
    {
      ...base,
      kind: "submitted",
      outcome: null,
      actor: "member",
      source: "member_proposals",
    },
    {
      ...base,
      kind: "reviewed",
      outcome: "rejected",
      actor: "platform_admin",
      source: "member_proposals",
    },
  ]);
  expect(await events(accepted)).toEqual([
    {
      ...base,
      kind: "submitted",
      outcome: null,
      actor: "member",
      source: "member_proposals",
    },
    {
      ...base,
      kind: "reviewed",
      outcome: "accepted",
      actor: "moderator",
      source: "proposal_publications",
    },
    {
      ...base,
      kind: "accepted",
      outcome: null,
      actor: "moderator",
      source: "proposal_publications",
    },
    {
      ...base,
      kind: "published",
      outcome: null,
      actor: "member",
      permission: DISPLAY_PERMISSION,
      source: "proposal_publications",
    },
  ]);
  const text = JSON.stringify(
    (await pool.query("SELECT * FROM contribution_events")).rows,
  );
  for (const forbidden of [
    "Invented member method",
    "Original invented",
    "Please add",
    "Invented pseudonym",
    moderator.id,
    admin.id,
  ])
    expect(text).not.toContain(forbidden);
});

it("CM122-02 keeps revision history across a correction cycle, counts one first decision per revision and adds nothing on replay", async () => {
  const moderator = await staff("moderator"),
    owner = await member("professional");
  const id = await submitted(owner.token);
  const request = {
    expectedRevision: 1,
    feedback: "Please add one invented check.",
  };
  expect(await proposals.requestChanges(moderator.token, id, request)).toBe(
    "requested",
  );
  expect(await proposals.requestChanges(moderator.token, id, request)).toBe(
    "replayed",
  );
  expect(await proposals.submit(owner.token, id, true, 1)).toBe("conflict");
  expect(await proposals.editDraft(owner.token, id, value(1), 1)).toBe("saved");
  expect(await proposals.submit(owner.token, id, true, 2)).toBe("submitted");
  expect(await proposals.submit(owner.token, id, true, 2)).toBe("replayed");
  ready(await publications.accept(moderator.token, id, 2, true));
  // A later decision on an accepted revision stays history, not a second first decision.
  expect(
    await proposals.requestChanges(moderator.token, id, {
      expectedRevision: 2,
      feedback: "One more invented check.",
    }),
  ).toBe("requested");
  expect(
    (await events(id)).map((e) => [e.revision, e.kind, e.outcome, e.cause]),
  ).toEqual([
    [1, "submitted", null, null],
    [1, "reviewed", "changes_requested", null],
    [2, "submitted", null, null],
    [2, "reviewed", "accepted", null],
    [2, "accepted", null, null],
  ]);
});

it("CM122-03 separates owner sharing revocation, source-change revocation and source withdrawal; export is owner-only; deletion removes events", async () => {
  const moderator = await staff("moderator");
  const owner = await member("technical"),
    peer = await member("explorer");
  const shared = await submitted(owner.token, 1),
    changed = await submitted(owner.token, 2),
    withdrawn = await submitted(owner.token, 3);
  for (const id of [shared, changed]) {
    ready(await publications.accept(moderator.token, id, 1, true));
    ready(await publish(owner.token, id));
  }
  ready(await publications.withdraw(owner.token, shared, 1));
  expect(
    await proposals.requestChanges(moderator.token, changed, {
      expectedRevision: 1,
      feedback: "Please revise this invented example.",
    }),
  ).toBe("requested");
  expect(await proposals.withdraw(owner.token, withdrawn)).toBe(true);
  await submitted(peer.token, 4);

  const last = async (id: string) => (await events(id)).at(-1);
  expect(await last(shared)).toMatchObject({
    kind: "sharing_withdrawn",
    cause: "owner",
    actor: "member",
  });
  expect(await last(changed)).toMatchObject({
    kind: "sharing_withdrawn",
    cause: "source_change",
    actor: "system",
  });
  expect(await last(withdrawn)).toMatchObject({
    kind: "source_withdrawn",
    actor: "member",
  });
  // The source-change marker does not leak into a later owner action.
  const again = await submitted(owner.token, 5);
  ready(await publications.accept(moderator.token, again, 1, true));
  ready(await publish(owner.token, again));
  ready(await publications.withdraw(owner.token, again, 1));
  expect(await last(again)).toMatchObject({ cause: "owner" });

  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Export failed");
  expect(exported.payload.version).toBe("local-member-records-v51");
  const own = exported.payload.records.contributionEvents!;
  expect(own).toHaveLength((await events()).length - 1);
  expect(own).toContainEqual(
    expect.objectContaining({
      proposalId: changed,
      revision: 1,
      kind: "sharing_withdrawn",
      cause: "source_change",
      actorAuthority: "system",
      origin: "member",
      metricsVersion: "contribution-metrics-v1",
    }),
  );
  const text = JSON.stringify(own);
  expect(text).not.toContain(moderator.id);
  expect(text).not.toContain(peer.id);
  expect(Object.keys(own[0]!)).not.toContain("memberId");

  await db.remove(owner.id);
  expect((await events()).map((e) => e.kind)).toEqual(["submitted"]);
});

it("CM122-08 counts only submitted revisions as withdrawn and never a private draft", async () => {
  const moderator = await staff("moderator");
  const owner = await member("professional");
  const draft = (await proposals.createDraft(owner.token, value(1), false))!;
  expect(await proposals.withdraw(owner.token, draft)).toBe(true);
  expect(await events(draft)).toEqual([]);

  const edited = await submitted(owner.token, 2),
    reviewed = await submitted(owner.token, 3);
  for (const id of [edited, reviewed])
    expect(
      await proposals.requestChanges(moderator.token, id, {
        expectedRevision: 1,
        feedback: "Please revise this invented example.",
      }),
    ).toBe("requested");
  expect(await proposals.editDraft(owner.token, edited, value(4), 1)).toBe(
    "saved",
  );
  expect(await proposals.withdraw(owner.token, edited)).toBe(true);
  expect(await proposals.withdraw(owner.token, reviewed)).toBe(true);
  const kinds = async (id: string) =>
    (await events(id)).map((e) => `${e.kind}@${e.revision}`);
  expect(await kinds(edited)).toEqual(["submitted@1", "reviewed@1"]);
  expect(await kinds(reviewed)).toEqual([
    "submitted@1",
    "reviewed@1",
    "source_withdrawn@1",
  ]);
});

it("CM122-09 credits an owner's withdrawal of a shared proposal to the owner and a moderator rejection to the source change", async () => {
  const moderator = await staff("moderator");
  const owner = await member("technical");
  const withdrawn = await submitted(owner.token, 1),
    rejected = await submitted(owner.token, 2);
  for (const id of [withdrawn, rejected]) {
    ready(await publications.accept(moderator.token, id, 1, true));
    ready(await publish(owner.token, id));
  }
  expect(await proposals.withdraw(owner.token, withdrawn)).toBe(true);
  expect(await proposals.moderate(moderator.token, rejected, "reject")).toBe(
    true,
  );
  const ended = async (id: string) =>
    (await events(id)).filter((e) =>
      ["sharing_withdrawn", "source_withdrawn"].includes(e.kind),
    );
  const owned = await ended(withdrawn);
  expect(owned).toHaveLength(2);
  expect(owned).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "sharing_withdrawn",
        cause: "owner",
        actor: "member",
      }),
      expect.objectContaining({ kind: "source_withdrawn", actor: "member" }),
    ]),
  );
  expect(await ended(rejected)).toEqual([
    expect.objectContaining({
      kind: "sharing_withdrawn",
      cause: "source_change",
      actor: "system",
    }),
  ]);
});

it("CM122-04 discloses only coarse bands at 20 contributors with five owners per cell and complement, and suppresses below", async () => {
  const moderator = await staff("moderator"),
    operator = await staff("operator");
  const owners = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      member((["explorer", "professional", "technical"] as const)[n % 3]),
    ),
  );
  const ids: string[] = [];
  for (const [n, o] of owners.slice(0, 19).entries())
    ids.push(await submitted(o.token, n));
  const below = (await metrics.snapshot(operator.token))!.contributions;
  expect(below.version).toBe("contribution-metrics-v1");
  expect(below.measuredSince).toBeInstanceOf(Date);
  expect(below.groups.map((g) => g.disclosure)).toEqual([
    "suppressed",
    "suppressed",
  ]);
  expect(JSON.stringify(below.groups)).not.toMatch(/\b19\b|\b0\b/);

  ids.push(await submitted(owners[19]!.token, 19));
  // One prolific owner adds revisions but not owners.
  for (let n = 0; n < 6; n++) await submitted(owners[0]!.token, 100 + n);
  for (const id of ids.slice(0, 6))
    ready(await publications.accept(moderator.token, id, 1, true));
  for (const id of ids.slice(6, 10))
    expect(await proposals.moderate(moderator.token, id, "reject")).toBe(true);
  const four = (await metrics.snapshot(operator.token))!.contributions;
  expect(four.groups[0]).toMatchObject({
    origin: "member",
    disclosure: "disclosed",
    volumes: {
      submitted: "20-49",
      reviewed: "5-19",
      accepted: "5-19",
      published: null,
      sourceWithdrawn: null,
    },
    firstDecisionAcceptanceBand: null,
  });
  expect(four.groups[1]!.disclosure).toBe("suppressed");

  expect(await proposals.moderate(moderator.token, ids[10]!, "reject")).toBe(
    true,
  );
  const five = (await metrics.snapshot(operator.token))!.contributions;
  expect(five.groups[0]!.firstDecisionAcceptanceBand).toBe("50-74%");
  expect(JSON.stringify(five)).not.toMatch(/"(revisions|owners|contributors)"/);
});

it("CM122-05 keeps sample-origin events separate from member-origin events", async () => {
  const owner = await member();
  await submitted(owner.token, 1, true);
  await submitted(owner.token, 2);
  expect((await events()).map((e) => e.origin)).toEqual(["sample", "member"]);
});

it("CM122-06 denies the aggregate to members, moderators and expired staff", async () => {
  const owner = await member(),
    moderator = await staff("moderator");
  await submitted(owner.token);
  expect(await metrics.snapshot(owner.token)).toBeNull();
  expect(await metrics.snapshot(moderator.token)).toBeNull();
  const expired = token();
  await auth.provisionStaff(
    expired,
    "operator",
    new Date(Date.now() + 3600000),
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    [hash(expired)],
  );
  expect(await metrics.snapshot(expired)).toBeNull();
});

it("CM122-07 records nothing for a rolled-back transition and keeps events immutable", async () => {
  const owner = await member();
  const id = (await proposals.createDraft(owner.token, value(), false))!;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE member_proposals SET state='submitted',rights_attested_revision=1,rights_attested_at=clock_timestamp(),submitted_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    expect(
      (await client.query("SELECT count(*)::int n FROM contribution_events"))
        .rows[0].n,
    ).toBe(1);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  expect(await events()).toEqual([]);
  await submitted(owner.token, 1);
  await expect(
    pool.query("UPDATE contribution_events SET revision=2"),
  ).rejects.toThrow("Contribution events are immutable");
});
