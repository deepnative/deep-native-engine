import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  MAX_MEMBER_EXPORT_RECORDS,
  memberExportStore,
} from "../../src/member-export.ts";
import { memberSharingStore } from "../../src/member-sharing.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// #40 STAFFEXPORT: When staff opened my work, as a section of Download my records.
const pool = testPool(),
  members = store(pool),
  exporter = memberExportStore(pool),
  sharing = memberSharingStore(pool);

beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  return { token, id: session.learner.id };
}

type Ids = Record<"actor" | "grant" | "other", string>;
const ids = (): Ids => ({
  actor: randomUUID(),
  grant: randomUUID(),
  other: randomUUID(),
});

async function workspaceRead(workspace: string, i = ids()) {
  await pool.query(
    `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action)
     VALUES($1,$1,$2,'assignment',$3,'workspace_read')`,
    [i.actor, workspace, i.grant],
  );
  return i;
}
async function fileOpened(workspace: string, evidence: string, i = ids()) {
  await pool.query(
    `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action,evidence_id,assignment_grant_id)
     VALUES($1,$1,$2,'assignment',$3,'evidence_bytes_loaded',$4,$5)`,
    [i.actor, workspace, i.grant, evidence, i.grant],
  );
  return i;
}
async function sampleRead(workspace: string, evidence: string, i = ids()) {
  await pool.query(
    `INSERT INTO private_sample_feedback_audit(id,workspace_id,evidence_id,submission_id,actor_id,assignment_id,exact_grant_id,action)
     VALUES($1,$2,$3,$4,$5,$6,$7,'read')`,
    [randomUUID(), workspace, evidence, i.other, i.actor, i.other, i.grant],
  );
  return i;
}
async function proposalRead(workspace: string, proposal: string, i = ids()) {
  await pool.query(
    `INSERT INTO proposal_audit(actor_id,actor_role,workspace_id,member_id,proposal_id,action,old_state,new_state)
     VALUES($1,'moderator',$2,$2,$3,'proposal_read','submitted','submitted')`,
    [i.actor, workspace, proposal],
  );
  return i;
}
async function noteRead(workspace: string, i = ids()) {
  await pool.query(
    `INSERT INTO workflow_review_read_audit(id,workspace_id,actor_id,grant_id,request_id,workflow_id,workflow_version,revision)
     VALUES($1,$2,$3,$4,$5,'WF-001',3,1)`,
    [randomUUID(), workspace, i.actor, i.grant, i.other],
  );
  return i;
}

async function allPages(token: string) {
  const pages = [];
  let cursor: string | undefined;
  do {
    const result = await exporter.exportOwned(token, cursor);
    if (result.kind !== "ready") throw Error(`Export was ${result.kind}`);
    pages.push(result.payload);
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}
const staffAccess = (pages: Awaited<ReturnType<typeof allPages>>) =>
  pages.flatMap((page) => page.records.staffAccess ?? []);

it("STAFFEXPORT-01 the download lists each kind of staff access with what, who and when", async () => {
  const owner = await member(),
    evidence = randomUUID(),
    proposal = randomUUID();
  await workspaceRead(owner.id);
  await fileOpened(owner.id, evidence);
  await sampleRead(owner.id, evidence);
  await proposalRead(owner.id, proposal);
  await noteRead(owner.id);

  const pages = await allPages(owner.token);
  expect(pages[0]!.version).toBe("local-member-records-v46");
  const rows = staffAccess(pages);
  expect(rows).toHaveLength(5);
  const by = (source: string, action: string) =>
    rows.find((row) => row.source === source && row.action === action);
  expect(by("access", "workspace_read")).toMatchObject({
    via: "assignment",
    evidenceId: null,
  });
  expect(by("access", "evidence_bytes_loaded")).toMatchObject({
    via: "assignment",
    evidenceId: evidence,
  });
  // #44 walk: every entry names the kind of staff, as the page does.
  expect(by("feedback", "read")).toMatchObject({
    via: "reviewer",
    evidenceId: evidence,
  });
  expect(by("proposal", "proposal_read")).toMatchObject({
    via: "moderator",
    proposalId: proposal,
  });
  expect(by("workflow", "note_read")).toMatchObject({
    via: "moderator",
    workflowId: "WF-001",
    workflowVersion: 3,
  });
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(
      [
        "action",
        "evidenceId",
        "occurredAt",
        "proposalId",
        "source",
        "via",
        "workflowId",
        "workflowVersion",
      ].sort(),
    );
    expect(Number.isFinite(Date.parse(String(row.occurredAt)))).toBe(true);
  }
  // The same entries as the page, so the two never disagree.
  const page = await sharing.staffAccess(owner.token);
  if (page.kind !== "ready") throw Error("History missing");
  expect(rows.map((row) => `${row.source}:${row.action}`).sort()).toEqual(
    page.value.entries.map((row) => `${row.source}:${row.action}`).sort(),
  );
});

it("STAFFEXPORT-02 no staff identity, grant, assignment, request or purpose is exported", async () => {
  const owner = await member(),
    evidence = randomUUID();
  const secrets = [
    await workspaceRead(owner.id),
    await fileOpened(owner.id, evidence),
    await sampleRead(owner.id, evidence),
    await proposalRead(owner.id, randomUUID()),
    await noteRead(owner.id),
  ];
  await pool.query(
    `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action)
     VALUES($1,$1,$2,'support',$3,'support_content_read')`,
    [randomUUID(), owner.id, randomUUID()],
  );
  const text = JSON.stringify(staffAccess(await allPages(owner.token)));
  for (const secret of secrets)
    for (const value of Object.values(secret))
      expect(text).not.toContain(value);
  expect(text).not.toMatch(/actor|staff_?id|grant|purpose|request|note"/i);
  expect(text).toContain("support_content_read");
});

it("STAFFEXPORT-03 another member's history never appears", async () => {
  const owner = await member(),
    peer = await member();
  await workspaceRead(peer.id);
  await noteRead(peer.id);
  await proposalRead(peer.id, randomUUID());
  await workspaceRead(owner.id);

  const rows = staffAccess(await allPages(owner.token));
  expect(rows.map((row) => `${row.source}:${row.action}`)).toEqual([
    "access:workspace_read",
  ]);
  expect(staffAccess(await allPages(peer.token))).toHaveLength(3);
});

it("STAFFEXPORT-04 pages neither repeat nor skip history entries", async () => {
  const owner = await member(),
    total = MAX_MEMBER_EXPORT_RECORDS + 30;
  for (let i = 0; i < total; i++)
    // Every entry carries its own ID, so a repeat or a gap is visible.
    if (i % 3 === 0) await fileOpened(owner.id, randomUUID());
    else if (i % 3 === 1) await sampleRead(owner.id, randomUUID());
    else await proposalRead(owner.id, randomUUID());

  const pages = await allPages(owner.token);
  expect(pages.length).toBeGreaterThan(1);
  const rows = staffAccess(pages);
  expect(rows).toHaveLength(total);
  expect(
    new Set(
      rows.map((row) => `${row.source}:${row.evidenceId}:${row.proposalId}`),
    ).size,
  ).toBe(total);
  expect(pages.at(-1)!.page.complete).toBe(true);
});

it("STAFFEXPORT-04 a member being deleted gets no download, history included", async () => {
  const owner = await member();
  await workspaceRead(owner.id);
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [owner.id],
  );
  expect(await exporter.exportOwned(owner.token)).toEqual({ kind: "denied" });
});
