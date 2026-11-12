import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { type TermsResult } from "../../src/coaching-terms.ts";
import { coachingAgreedChangesStore } from "../../src/coaching-agreed-changes.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { memberExportStore } from "../../src/member-export.ts";

// #94 under the owner's 9 and 10 Nov 2026 decisions: no automatic cancellation
// or refund rules; an administrator records what was agreed with a student.
// Invented people and text only.
const pool = testPool(),
  members = store(pool),
  changes = coachingAgreedChangesStore(pool),
  auth = authorizationStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "agreed-changes-test";
const application = app(members, {
  origin,
  secret,
  mode: "test",
  simpleInvoices: simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  }),
  agreedChanges: changes,
});
const ready = <T>(result: TermsResult<T>): T => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
  return result.value;
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error();
  return { token, id: s.learner.id };
}
async function staff(role: "platform_admin" | "reviewer" = "platform_admin") {
  const token = randomBytes(32).toString("hex");
  const id = await auth.provisionStaff(
    token,
    role,
    new Date(Date.now() + 3600000),
  );
  return { token, id };
}
const release = {
  kind: "early_release" as const,
  agreed: "Invented: coaching ends on 31 January instead of 31 May.",
  reason: "Invented: the student is moving abroad.",
};
const refund = {
  kind: "refund" as const,
  agreed: "Invented: CAD 300.00 is refunded by e-Transfer.",
  reason: "Invented: two coaching sessions were not delivered.",
};
const input = (ownerId: string, values: typeof release | typeof refund) => ({
  ...values,
  ownerId,
  operationId: randomUUID(),
});
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const post = (
  path: string,
  token: string,
  fields: Record<string, string>,
  from = origin,
  anti = csrf(token, secret),
) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", from)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: anti, ...fields }),
  );
const stored = async (id: string) =>
  (
    await pool.query<{ kind: string; agreed: string; reason: string }>(
      "SELECT kind,agreed,reason FROM coaching_agreed_changes WHERE owner_id=$1 ORDER BY created_at,id",
      [id],
    )
  ).rows;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
let admin: Awaited<ReturnType<typeof staff>>;
beforeAll(async () => {
  await migrate(pool);
  admin = await staff();
});
afterAll(() => pool.end());

it("AGREED94-01 an administrator records an agreed early release and an agreed refund on the student's coaching page, newest first", async () => {
  const m = await member();
  const page = await get(`/operator/coaching/${m.id}`, admin.token);
  expect(page.status).toBe(200);
  expect(text(page.text)).toContain(
    "No agreed changes are recorded for this student.",
  );
  const path = `/operator/coaching/${m.id}/agreed-change`;
  const saved = await post(path, admin.token, {
    operationId: randomUUID(),
    ...release,
    confirm: "agreed-change",
  });
  expect(saved.status).toBe(303);
  expect(saved.headers.location).toBe(
    `/operator/coaching/${m.id}#agreed-changes`,
  );
  expect(
    (
      await post(path, admin.token, {
        operationId: randomUUID(),
        ...refund,
        confirm: "agreed-change",
      })
    ).status,
  ).toBe(303);
  expect(await stored(m.id)).toEqual([release, refund]);
  const after = text(
    (await get(`/operator/coaching/${m.id}`, admin.token)).text,
  );
  expect(after).toContain(`Agreed: ${release.agreed}`);
  expect(after).toContain(`Reason: ${release.reason}`);
  expect(after.indexOf("Refund · recorded")).toBeGreaterThan(-1);
  expect(after.indexOf("Refund · recorded")).toBeLessThan(
    after.indexOf("Early release · recorded"),
  );
});

it("AGREED94-02 a record can't be edited or removed, and replaying the same request records nothing more", async () => {
  const m = await member();
  const first = input(m.id, release);
  const { id } = ready(await changes.record(admin.token, first));
  expect(ready(await changes.record(admin.token, first))).toEqual({ id });
  expect(
    await changes.record(admin.token, { ...first, reason: "Another reason" }),
  ).toEqual({ kind: "conflict" });
  expect(await stored(m.id)).toEqual([release]);
  await expect(
    pool.query("UPDATE coaching_agreed_changes SET agreed='x' WHERE id=$1", [
      id,
    ]),
  ).rejects.toThrow("Coaching history is immutable");
  await expect(
    pool.query("DELETE FROM coaching_agreed_changes WHERE id=$1", [id]),
  ).rejects.toThrow("Coaching history is immutable");
  expect(await stored(m.id)).toEqual([release]);
});

it("AGREED94-03 the student sees their own records read-only with the contact line, and nobody else's", async () => {
  const m = await member(),
    other = await member();
  ready(await changes.record(admin.token, input(m.id, refund)));
  const page = await get("/account/coaching", m.token);
  expect(page.status).toBe(200);
  const body = text(page.text);
  expect(body).toContain("Changes agreed with you");
  expect(body).toContain("No cancellation or refund happens automatically.");
  expect(body).toContain(`Agreed: ${refund.agreed}`);
  expect(body).toContain(`Reason: ${refund.reason}`);
  expect(page.text).toContain('href="mailto:info@deepnative.io"');
  expect(page.text).not.toContain("/agreed-change");
  expect(page.text).not.toContain(admin.id);
  expect(ready(await changes.own(m.token))).toMatchObject([refund]);
  expect(ready(await changes.own(other.token))).toEqual([]);
  expect(text((await get("/account/coaching", other.token)).text)).toContain(
    "No agreed changes are recorded.",
  );
});

it("AGREED94-04 an unconfirmed, empty, over-long or unknown-kind change is refused and nothing is recorded", async () => {
  const m = await member();
  const path = `/operator/coaching/${m.id}/agreed-change`;
  const fields = {
    operationId: randomUUID(),
    ...release,
    confirm: "agreed-change",
  };
  for (const wrong of [
    { confirm: "no" },
    { kind: "cancel" },
    { agreed: "   " },
    { reason: "x".repeat(1001) },
  ])
    expect(
      (await post(path, admin.token, { ...fields, ...wrong })).status,
      JSON.stringify(wrong),
    ).toBe(422);
  await expect(
    pool.query(
      "INSERT INTO coaching_agreed_changes(id,owner_id,kind,agreed,reason,actor_id,operation_id,digest) VALUES($1,$2,'cancel','a','b',$3,$4,$5)",
      [randomUUID(), m.id, admin.id, randomUUID(), "a".repeat(64)],
    ),
  ).rejects.toThrow(/check constraint/);
  expect(await stored(m.id)).toEqual([]);
});

it("AGREED94-05 only a platform administrator with a valid form can record, and only for a current student", async () => {
  const m = await member();
  const path = `/operator/coaching/${m.id}/agreed-change`;
  const fields = {
    operationId: randomUUID(),
    ...release,
    confirm: "agreed-change",
  };
  const reviewer = await staff("reviewer");
  expect((await post(path, reviewer.token, fields)).status).toBe(403);
  expect((await post(path, m.token, fields)).status).toBe(403);
  expect(
    (await post(path, admin.token, fields, "http://127.0.0.1:9")).status,
  ).toBe(403);
  expect((await post(path, admin.token, fields, origin, "wrong")).status).toBe(
    403,
  );
  expect(await changes.record(reviewer.token, input(m.id, release))).toEqual({
    kind: "denied",
  });
  expect(await changes.record(m.token, input(m.id, release))).toEqual({
    kind: "denied",
  });
  expect(
    await changes.record(admin.token, input(randomUUID(), release)),
  ).toEqual({ kind: "denied" });
  expect(await changes.forStudent(reviewer.token, m.id)).toEqual({
    kind: "denied",
  });
  expect(await stored(m.id)).toEqual([]);
});

it("AGREED94-06 the student's download has every record without the administrator, and deleting the account removes them", async () => {
  const m = await member();
  ready(await changes.record(admin.token, input(m.id, release)));
  ready(await changes.record(admin.token, input(m.id, refund)));
  const exporter = memberExportStore(pool);
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await exporter.exportOwned(m.token, cursor);
    if (page.kind !== "ready") throw Error("Expected an export page");
    expect(page.payload.version).toBe("local-member-records-v51");
    rows.push(...(page.payload.records.coachingAgreedChanges ?? []));
    cursor = page.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(
    rows
      .map(({ recordedAt, ...row }) => (expect(recordedAt).toBeTruthy(), row))
      .sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
  ).toEqual([release, refund]);
  expect(JSON.stringify(rows)).not.toMatch(/actor|operation|digest/);
  expect(JSON.stringify(rows)).not.toContain(admin.id);
  await pool.query("DELETE FROM principals WHERE id=$1", [m.id]);
  expect(await stored(m.id)).toEqual([]);
});
