import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { programEnrollmentStore } from "../../src/program-enrollments.ts";
import { PROGRAM_DIGEST, PROGRAM_PATH } from "../../src/program-values.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const catalog = catalogStore(pool);
const origin = "http://127.0.0.1:3000";
const secret = "invented-local-program-test-secret";
const programs = programEnrollmentStore(pool, "test");
const application = app(members, {
  origin,
  secret,
  catalog,
  programs,
});
const memberToken = randomBytes(32).toString("hex");

beforeAll(async () => {
  await migrate(pool);
  await seedDraftPack(pool);
  await members.create(memberToken, {
    background: "explorer",
    goal: "everyday",
  });
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const auth = authorizationStore(pool);
  const expires = new Date(Date.now() + 3600000);
  await auth.provisionStaff(editor, "editor", expires);
  await auth.provisionStaff(reviewer, "reviewer", expires);
  expect(await foundationImportStore(pool).import(editor)).toBe("imported");
  for (const item of await reviewedFoundation()) {
    expect(await catalog.submit(editor, item.id, item.version)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, item.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, item.id, item.version)).toBe(true);
  }
});
afterAll(() => pool.end());

it("PROGRAM-01/ENR-01 lets a student explore the exact local foundation term before enrollment", async () => {
  const response = await request(application)
    .get("/programs/foundation/terms/local-foundation-1")
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${memberToken}`);
  expect(response.status).toBe(200);
  expect(response.text).toContain("Local enrollment simulation");
  for (const item of await reviewedFoundation()) {
    expect(response.text).toContain(item.id);
    expect(response.text).toContain(item.title);
  }
  expect(response.text).toContain("version 2");
  expect(response.text).toContain("not open");
});

it("PROGRAM-02/03/05/ENR-02/05 admits once only after explicit confirmation and preserves private work through closure and erasure", async () => {
  const admin = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const post = (path: string, token: string, fields: Record<string, string>) =>
    request(application)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields });
  expect(
    (
      await post("/operator/programs/open", memberToken, {
        confirm: "yes",
        revision: "1",
        digest: PROGRAM_DIGEST,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post("/operator/programs/open", admin, {
        confirm: "yes",
        revision: "1",
        digest: PROGRAM_DIGEST,
      })
    ).status,
  ).toBe(303);
  await members.save(memberToken, {
    revision: 0,
    instruction: "Invented first plan retained before enrollment",
    verification: "Check this invented plan against the source",
    complete: true,
  });
  const original = await members.session(memberToken);
  expect(original.kind).toBe("active");
  const originalWork = await members.withExerciseRead(
    memberToken,
    (rows) => rows,
  );
  expect(originalWork).toHaveLength(1);
  expect(originalWork?.[0]?.instruction).toBe(
    "Invented first plan retained before enrollment",
  );
  const chosen = await post(`${PROGRAM_PATH}/choose`, memberToken, {
    confirm: "yes",
  });
  expect(chosen.status).toBe(303);
  const selection = (chosen.headers["set-cookie"] as unknown as string[])
    .find((value) => value.startsWith("dne_program_selection="))!
    .split(";")[0]!;
  expect(await programs.mine(memberToken)).toEqual({
    kind: "ready",
    value: null,
  });
  const form = await request(application)
    .get(chosen.headers.location!)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${memberToken}; ${selection}`);
  expect(form.status).toBe(200);
  expect(form.text).toContain("Confirm local enrollment");
  const key = form.text.match(/name="key" value="([a-f0-9-]+)"/)![1]!;
  const fields = {
    key,
    confirm: "yes",
    programVersion: "1",
    termVersion: "1",
    revision: "2",
    digest: PROGRAM_DIGEST,
  };
  expect(
    (await post(`${PROGRAM_PATH}/enroll`, memberToken, fields)).status,
  ).toBe(303);
  expect(
    (await post(`${PROGRAM_PATH}/enroll`, memberToken, fields)).status,
  ).toBe(303);
  expect(
    (
      await post(`${PROGRAM_PATH}/enroll`, memberToken, {
        ...fields,
        termVersion: "2",
      })
    ).status,
  ).toBe(409);
  const own = await programs.mine(memberToken);
  expect(own.kind).toBe("ready");
  if (own.kind !== "ready" || !own.value) throw Error("Own enrollment missing");
  const id = own.value.id;
  const other = randomBytes(32).toString("hex");
  await members.create(other, { background: "professional", goal: "work" });
  const get = (path: string, token: string) =>
    request(application)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`);
  expect((await get(`/my-courses/${id}/download`, other)).status).toBe(404);
  expect(await programs.inspect(other, key)).toEqual({
    kind: "ready",
    value: null,
  });
  expect((await get("/my-courses", memberToken)).text).toContain(
    "No self-assessed activity recorded",
  );
  expect(await members.openLesson(memberToken, "FND-001", 2)).toBe(true);
  expect(await members.advanceLesson(memberToken, "FND-001", 2, "start")).toBe(
    true,
  );
  expect(
    await members.advanceLesson(memberToken, "FND-001", 2, "complete"),
  ).toBe(true);
  const download = await get(`/my-courses/${id}/download`, memberToken);
  expect(download.status).toBe(200);
  expect(download.headers["cache-control"]).toBe("no-store");
  expect(download.headers["content-disposition"]).toContain(
    "program-enrollment.json",
  );
  expect(download.body.programEnrollmentsVersion).toBe(1);
  expect(download.body.enrollment.activity).toContainEqual({
    id: "FND-001",
    version: 2,
    started: true,
    selfAssessed: true,
  });
  expect(download.text).not.toMatch(
    /workspace|principal|idempotency|fingerprint|token|invented first plan/i,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM local_program_enrollments",
      )
    ).rows[0].n,
  ).toBe(1);
  // ENR-PIN01: a saved enrolled link must not open a later publication.
  const savedCoursePage = await get("/my-courses", memberToken);
  const savedLessonLink = savedCoursePage.text.match(
    /href="([^"]*\/library\/FND-001[^"]*)"/,
  )?.[1];
  if (!savedLessonLink) throw Error("Enrolled lesson link missing");
  expect((await get(savedLessonLink, memberToken)).status).toBe(200);
  const acceptedBeforePublication = await programs.mine(memberToken);
  const sourceEditor = randomBytes(32).toString("hex");
  const sourceReviewer = randomBytes(32).toString("hex");
  const authority = authorizationStore(pool);
  const sourceExpiry = new Date(Date.now() + 3600000);
  await authority.provisionStaff(sourceEditor, "editor", sourceExpiry);
  await authority.provisionStaff(sourceReviewer, "reviewer", sourceExpiry);
  const newerLesson = { ...(await reviewedFoundation())[0]!, version: 3 };
  expect(await catalog.createDraft(sourceEditor, newerLesson)).toBe(true);
  expect(await catalog.submit(sourceEditor, newerLesson.id, 3)).toBe(true);
  expect(await catalog.approve(sourceReviewer, newerLesson.id, 3, true)).toBe(
    true,
  );
  expect(await catalog.publish(sourceEditor, newerLesson.id, 3)).toBe(true);
  const savedLinkResult = await get(savedLessonLink, memberToken);
  expect(savedLinkResult.status).toBe(409);
  expect(savedLinkResult.text).toContain("Content version unavailable");
  expect(await programs.mine(memberToken)).toEqual(acceptedBeforePublication);
  expect(
    (await members.lessonActivities(memberToken)).some(
      (activity) =>
        activity.contentId === newerLesson.id && activity.contentVersion === 3,
    ),
  ).toBe(false);
  expect(
    (
      await post("/operator/programs/close", admin, {
        confirm: "yes",
        revision: "2",
        digest: PROGRAM_DIGEST,
      })
    ).status,
  ).toBe(303);
  expect(
    (await post(`${PROGRAM_PATH}/enroll`, memberToken, fields)).status,
  ).toBe(303);
  expect(
    (
      await post(`${PROGRAM_PATH}/enroll`, other, {
        ...fields,
        key: "108d494a-596f-49b4-b0db-71ce1eed1fa7",
      })
    ).status,
  ).toBe(409);
  const retained = await members.session(memberToken);
  if (original.kind !== "active" || retained.kind !== "active")
    throw Error("Original account lost");
  expect(retained.learner).toEqual(original.learner);
  expect(await members.withExerciseRead(memberToken, (rows) => rows)).toEqual(
    originalWork,
  );
  await members.remove(original.learner.id);
  expect(await programs.mine(memberToken)).toEqual({ kind: "denied" });
  expect((await get(`/my-courses/${id}/download`, memberToken)).status).toBe(
    401,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM local_program_enrollments",
      )
    ).rows[0].n,
  ).toBe(0);
});
