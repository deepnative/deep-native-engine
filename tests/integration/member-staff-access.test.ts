import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { evidenceStore } from "../../src/evidence.ts";
import {
  memberSharingStore,
  STAFF_ACCESS_PAGE,
} from "../../src/member-sharing.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

const pool = testPool(),
  members = store(pool),
  access = authorizationStore(pool),
  sharing = memberSharingStore(pool),
  evidence = evidenceStore(
    pool,
    {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => Buffer.from("invented")),
      remove: vi.fn(async () => {}),
    },
    "invented-staff-access-secret",
  ),
  tomorrow = () => new Date(Date.now() + 86_400_000);

beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

const newToken = () => randomBytes(32).toString("hex");
async function member() {
  const token = newToken();
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member missing");
  return { token, id: session.learner.id };
}
async function staffMember(
  role: "platform_admin" | "coach" | "reviewer" | "operator",
) {
  const token = newToken();
  return { token, id: await access.provisionStaff(token, role, tomorrow()) };
}
async function history(token: string, before?: string) {
  const result = await sharing.staffAccess(token, before);
  if (result.kind !== "ready") throw Error(`History was ${result.kind}`);
  return result.value;
}
async function active(token: string) {
  const result = await sharing.summary(token);
  if (result.kind !== "ready") throw Error(`Summary was ${result.kind}`);
  return result.value.staffWithAccess;
}
const shape = (
  rows: { source: string; action: string; via: string | null }[],
) => rows.map((row) => `${row.source}:${row.action}:${row.via}`);

async function evidenceEvent(
  workspace: string,
  evidenceId: string,
  action = "evidence_bytes_loaded",
  at = "clock_timestamp()",
) {
  const grant = randomUUID(),
    actor = randomUUID();
  await pool.query(
    `INSERT INTO authorization_audit(actor_id,staff_id,workspace_id,grant_type,grant_id,action,evidence_id,assignment_grant_id,occurred_at)
     VALUES($1,$1,$2,'assignment',$3,$4,$5,$3,${at})`,
    [actor, workspace, grant, action, evidenceId],
  );
}
async function upload(token: string, name: string) {
  const made = await evidence.upload(token, {
    name,
    mediaType: "text/plain",
    data: Buffer.from("Invented private text."),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (made.kind !== "created") throw Error(`Upload was ${made.kind}`);
  return made.id;
}

it("STAFFSEE-01 a new member has no recorded or active staff access", async () => {
  const { token } = await member();
  expect(await history(token)).toEqual({ entries: [], older: null });
  expect(await active(token)).toBe(0);
});

it("STAFFSEE-02 opening a workspace shows when and by which kind of access, newest first", async () => {
  const owner = await member(),
    admin = await staffMember("platform_admin"),
    coach = await staffMember("coach"),
    operator = await staffMember("operator");
  await access.grantAssignment(
    admin.id,
    coach.id,
    owner.id,
    "coach",
    "Invented coaching purpose",
    tomorrow(),
  );
  expect(await access.readWorkspace(coach.token, owner.id)).toMatchObject({
    kind: "allowed",
  });
  await access.grantSupport(
    admin.id,
    operator.id,
    owner.id,
    "operator",
    "Invented support purpose",
    tomorrow(),
  );
  expect(
    await access.readWorkspace(
      operator.token,
      owner.id,
      "Invented support purpose",
    ),
  ).toMatchObject({ kind: "allowed" });

  const { entries } = await history(owner.token);
  expect(shape(entries)).toEqual([
    "access:workspace_read:support",
    "access:grant_created:support",
    "access:workspace_read:assignment",
    "access:grant_created:assignment",
  ]);
  for (const [newer, older] of entries.slice(1).map((e, i) => [entries[i]!, e]))
    expect(+newer!.at).toBeGreaterThanOrEqual(+older!.at);
});

it("STAFFSEE-03 a file shows by name only while the member still holds it", async () => {
  const owner = await member(),
    peer = await member(),
    kept = await upload(owner.token, "Invented kept.txt"),
    going = await upload(owner.token, "Invented going.txt"),
    theirs = await upload(peer.token, "Invented peer file.txt");
  await evidenceEvent(owner.id, kept, "evidence_link_issued");
  await evidenceEvent(owner.id, going);
  await evidenceEvent(owner.id, randomUUID());
  await evidenceEvent(owner.id, theirs);
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
    [going],
  );

  const { entries } = await history(owner.token);
  expect(entries.map((entry) => entry.file)).toEqual([
    null,
    null,
    null,
    "Invented kept.txt",
  ]);
  expect(JSON.stringify(entries)).not.toContain("peer file");
});

it("STAFFSEE-04 sample feedback and proposal staff actions are listed", async () => {
  const owner = await member(),
    file = await upload(owner.token, "Invented sample.txt");
  for (const action of ["read", "draft-saved", "published", "answered"])
    await pool.query(
      `INSERT INTO private_sample_feedback_audit(id,workspace_id,evidence_id,submission_id,actor_id,assignment_id,exact_grant_id,action)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        owner.id,
        file,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        action,
      ],
    );
  await pool.query(
    `INSERT INTO proposal_audit(actor_id,actor_role,workspace_id,member_id,proposal_id,action,old_state,new_state)
     VALUES($1,'moderator',$2,$2,$3,'proposal_read','submitted','submitted'),
           ($1,'platform_admin',$2,$2,$3,'proposal_rejected','submitted','rejected')`,
    [randomUUID(), owner.id, randomUUID()],
  );
  const { entries } = await history(owner.token);
  expect(shape(entries).sort()).toEqual(
    [
      "feedback:answered:null",
      "feedback:draft-saved:null",
      "feedback:published:null",
      "feedback:read:null",
      "proposal:proposal_read:moderator",
      "proposal:proposal_rejected:platform_admin",
    ].sort(),
  );
  expect(
    entries.filter((e) => e.source === "feedback").map((e) => e.file),
  ).toEqual(Array(4).fill("Invented sample.txt"));
});

it("STAFFSEE-05 given and ended access both show; only access active now is counted", async () => {
  const owner = await member(),
    admin = await staffMember("platform_admin"),
    coach = await staffMember("coach"),
    operator = await staffMember("operator"),
    departed = await staffMember("coach"),
    purpose = "Invented purpose";
  const first = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.id,
    "coach",
    purpose,
    tomorrow(),
  );
  const second = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.id,
    "coach",
    `${purpose} again`,
    tomorrow(),
  );
  expect(await active(owner.token)).toBe(1); // one person, two grants
  const support = await access.grantSupport(
    admin.id,
    operator.id,
    owner.id,
    "operator",
    purpose,
    tomorrow(),
  );
  expect(await active(owner.token)).toBe(2);

  // Not yet started, already expired, or whose account has gone: none can read.
  await access.grantAssignment(
    admin.id,
    departed.id,
    owner.id,
    "coach",
    purpose,
    tomorrow(),
  );
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [departed.id],
  );
  expect(await active(owner.token)).toBe(2);
  await pool.query(
    "UPDATE assignment_grants SET starts_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
    [first],
  );
  await pool.query(
    "UPDATE assignment_grants SET starts_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
    [second],
  );
  expect(await active(owner.token)).toBe(1);

  expect(await access.revokeSupport(admin.id, support)).toBe(true);
  expect(await active(owner.token)).toBe(0);
  const { entries } = await history(owner.token);
  expect(shape(entries)[0]).toBe("access:grant_revoked:support");
  expect(shape(entries)).toContain("access:grant_created:support");
});

it("STAFFSEE-06 older entries neither repeat nor skip, even at the same moment", async () => {
  const owner = await member(),
    peer = await member(),
    total = STAFF_ACCESS_PAGE * 2 + 5;
  // Every entry shares one time, and the sources mix across pages.
  const moment = "'2026-11-05T12:00:00.123456Z'::timestamptz";
  for (let i = 0; i < total; i += 1)
    if (i % 2)
      await evidenceEvent(
        owner.id,
        randomUUID(),
        "evidence_bytes_loaded",
        moment,
      );
    else
      await pool.query(
        `INSERT INTO proposal_audit(actor_id,actor_role,workspace_id,member_id,proposal_id,action,old_state,new_state,occurred_at)
         VALUES($1,'moderator',$2,$2,$3,'proposal_read','submitted','submitted',${moment})`,
        [randomUUID(), owner.id, randomUUID()],
      );

  const first = await history(owner.token);
  const second = await history(owner.token, first.older!);
  const third = await history(owner.token, second.older!);
  expect(first.entries).toHaveLength(STAFF_ACCESS_PAGE);
  expect(second.entries).toHaveLength(STAFF_ACCESS_PAGE);
  expect(third.entries).toHaveLength(5);
  expect(third.older).toBeNull();
  const seen = [...first.entries, ...second.entries, ...third.entries];
  expect(seen.filter((e) => e.source === "proposal")).toHaveLength(
    Math.ceil(total / 2),
  );
  expect(seen.filter((e) => e.source === "access")).toHaveLength(
    Math.floor(total / 2),
  );

  // Another member's position reaches only that member's own empty history.
  expect((await history(peer.token, first.older!)).entries).toEqual([]);
  expect(await sharing.staffAccess(owner.token, "not-a-position")).toEqual({
    kind: "invalid",
  });
});

it("STAFFSEE-07 only the member's own entries, with no staff identity or purpose", async () => {
  const owner = await member(),
    peer = await member(),
    admin = await staffMember("platform_admin"),
    coach = await staffMember("coach"),
    purpose = "Invented confidential purpose",
    secret = "invented-staff-access-route-secret",
    origin = "http://127.0.0.1:1";
  const grant = await access.grantAssignment(
    admin.id,
    coach.id,
    owner.id,
    "coach",
    purpose,
    tomorrow(),
  );
  await access.readWorkspace(coach.token, owner.id);
  expect((await history(peer.token)).entries).toEqual([]);

  const server = await listenLoopback(
    app(members, { origin, secret, memberSharing: sharing }),
  );
  onTestFinished(() => closeLoopback(server));
  const open = (token: string, path = "/account/sharing/staff-access") =>
    request(server)
      .get(path)
      .set("Host", new URL(origin).host)
      .set("Cookie", `${COOKIE}=${token}`);
  const mine = await open(owner.token);
  expect(mine.status).toBe(200);
  expect(mine.text).toContain("Assigned staff opened your learning workspace.");
  expect(mine.headers["cache-control"]).toContain("no-store");
  for (const hidden of [coach.id, admin.id, grant, purpose]) {
    expect(mine.text).not.toContain(hidden);
    expect(JSON.stringify(await history(owner.token))).not.toContain(hidden);
  }
  const theirs = await open(peer.token);
  expect(theirs.text).toContain(
    "No staff access to your private work is recorded.",
  );
  const summary = await open(owner.token, "/account/sharing");
  expect(summary.text).toContain("1 staff member has access");
  expect(summary.text).toContain('href="/account/sharing/staff-access"');

  const signedOut = await request(server)
    .get("/account/sharing/staff-access")
    .set("Host", new URL(origin).host);
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.location).toBe("/");

  await members.remove(owner.id);
  expect(await sharing.staffAccess(owner.token)).toEqual({ kind: "denied" });
});
