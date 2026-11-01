import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { programEnrollmentFixture } from "../support/program-enrollment-recovery-server.ts";
import { PROGRAM_DIGEST, PROGRAM_PATH } from "../../src/program-values.ts";
import { catalogStore } from "../../src/catalog.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { hash } from "../../src/store.ts";
import { app } from "../../src/app.ts";
import { programEnrollmentStore } from "../../src/program-enrollments.ts";

import {
  programEnrollmentObservation,
  type ProgramEnrollmentObservation,
} from "../support/program-enrollment-observation.ts";

const intent = {
  programVersion: 1,
  termVersion: 1,
  revision: 2,
  digest: PROGRAM_DIGEST,
};
const responseCookie = (headers: Record<string, unknown>, name: string) => {
  const cookies = headers["set-cookie"] as string[] | undefined;
  const value = cookies
    ?.find((cookie) => cookie.startsWith(name + "="))
    ?.split(";")[0];
  if (!value) throw Error("Expected owned browser cookie missing");
  return value;
};
const cookieValue = (cookie: string) =>
  decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
const formFields = (html: string) =>
  Object.fromEntries(
    [
      ...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g),
    ].map((match) => [match[1]!, match[2]!]),
  );
async function ready(observation?: ProgramEnrollmentObservation) {
  const step: ProgramEnrollmentObservation["step"] =
    observation?.step ?? ((_phase, action) => action());
  const f = await programEnrollmentFixture(observation);
  try {
    const editorial = await step("publication", () => f.publish());
    const admin = await step("admin", () => f.staff("platform_admin"));
    expect(
      (
        await step("open", () =>
          f.programs.change(admin.token, "open", 1, PROGRAM_DIGEST),
        )
      ).kind,
    ).toBe("ready");
    return { ...f, editorial, admin };
  } catch (error) {
    await f.close();
    throw error;
  }
}
function gate() {
  let reached!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return { reached, resume, waiting, release };
}
async function blocked(pool: Pool) {
  // Read-only observation of this fresh fixture DB, not a replay of an action.
  await vi.waitFor(
    async () => {
      const result = await pool.query<{ n: number }>(
        `SELECT count(*)::integer n FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`,
      );
      expect(result.rows[0]!.n).toBeGreaterThan(0);
    },
    { timeout: 2000, interval: 10 },
  );
}
it("PROGRAM-03/ENR-03 admits only one concurrent winner for the last local simulation place", async () => {
  const f = await ready();
  try {
    for (let n = 0; n < 19; n++) {
      const member = await f.member();
      expect(
        (await f.programs.enroll(member.token, randomUUID(), intent)).kind,
      ).toBe("ready");
    }
    const a = await f.member("professional"),
      b = await f.member("technical");
    const result = await Promise.all([
      f.programs.enroll(a.token, randomUUID(), intent),
      f.programs.enroll(b.token, randomUUID(), intent),
    ]);
    expect(result.map((r) => r.kind).sort()).toEqual(["full", "ready"]);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::integer n FROM local_program_enrollments",
        )
      ).rows[0].n,
    ).toBe(20);
    expect(await f.programs.overview()).toMatchObject({
      kind: "ready",
      value: { availability: "full", remaining: 0 },
    });
  } finally {
    await f.close();
  }
}, 15000);
it("PROGRAM-02/03 serializes concurrent same-account keys into one immutable receipt", async ({
  task,
  onTestFinished,
}) => {
  const observation = programEnrollmentObservation(task.meta);
  onTestFinished(() => observation.seal());
  const f = await observation.step("ready", () => ready(observation));
  try {
    const member = await observation.step("member", () => f.member());
    const result = await Promise.all([
      observation.step("concurrent-admission-a", () =>
        f.programs.enroll(member.token, randomUUID(), intent),
      ),
      observation.step("concurrent-admission-b", () =>
        f.programs.enroll(member.token, randomUUID(), intent),
      ),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0].kind).toBe("ready");
    expect(f.state.inserts).toBe(1);
    const receipt = await observation.step("receipt", () =>
      f.programs.mine(member.token),
    );
    if (receipt.kind !== "ready" || !receipt.value)
      throw Error("Own receipt missing");
    await expect(
      observation.step("immutable-update", () =>
        f.pool.query(
          "UPDATE local_program_enrollments SET enrolled_at=clock_timestamp() WHERE id=$1",
          [receipt.value!.id],
        ),
      ),
    ).rejects.toThrow("immutable");
    await expect(
      observation.step("retained-delete", () =>
        f.pool.query("DELETE FROM local_program_enrollments WHERE id=$1", [
          receipt.value!.id,
        ]),
      ),
    ).rejects.toThrow("retained");
  } finally {
    await observation.step("close", () => f.close());
  }
});
it("PROGRAM-03 observes closure that commits while admission waits", async ({
  task,
  onTestFinished,
}) => {
  const observation = programEnrollmentObservation(task.meta);
  onTestFinished(() => observation.seal());
  const f = await observation.step("ready", () => ready(observation));
  const lock = await observation.step("lock-connect", () => f.pool.connect());
  try {
    const member = await observation.step("member", () => f.member());
    await observation.step("lock-begin", () => lock.query("BEGIN"));
    await observation.step("closure-update", () =>
      lock.query(
        "UPDATE local_program_terms SET state='closed',revision=3 WHERE id='local-foundation-1'",
      ),
    );
    const admission = observation.step("admission", () =>
      f.programs.enroll(member.token, randomUUID(), intent),
    );
    await observation.step("blocked", () => blocked(f.pool));
    await observation.step("closure-commit", () => lock.query("COMMIT"));
    expect(await admission).toEqual({ kind: "stale" });
    expect(f.state.inserts).toBe(0);
  } finally {
    await observation.step("rollback", () => lock.query("ROLLBACK"));
    lock.release();
    await observation.step("close", () => f.close());
  }
});
it("PROGRAM-03 retains an admission committed before a waiting closure", async () => {
  const f = await ready();
  const pause = gate();
  try {
    const member = await f.member();
    f.state.pause = {
      after: "WHERE id='local-foundation-1' FOR UPDATE",
      reached: pause.reached,
      resume: pause.release,
    };
    const admission = f.programs.enroll(member.token, randomUUID(), intent);
    await pause.waiting;
    const closure = f.programs.change(
      f.admin.token,
      "close",
      2,
      PROGRAM_DIGEST,
    );
    await blocked(f.pool);
    pause.resume();
    expect((await admission).kind).toBe("ready");
    expect((await closure).kind).toBe("ready");
    expect(await f.programs.mine(member.token)).toMatchObject({
      kind: "ready",
      value: { digest: PROGRAM_DIGEST },
    });
  } finally {
    pause.resume();
    await f.close();
  }
});
for (const operation of ["retire", "publish-newer"] as const) {
  it(`PROGRAM-01/03 rejects admission after waiting for actual catalog ${operation}`, async () => {
    const f = await ready();
    const writer = await f.pool.connect();
    try {
      const member = await f.member();
      await writer.query("BEGIN");
      const catalog = catalogStore({
        query: writer.query.bind(writer),
      } as unknown as Pool);
      if (operation === "retire")
        expect(await catalog.retire(f.editorial.editor.token, "FND-001")).toBe(
          true,
        );
      else {
        const item = { ...(await reviewedFoundation())[0]!, version: 3 };
        expect(await catalog.createDraft(f.editorial.editor.token, item)).toBe(
          true,
        );
        expect(await catalog.submit(f.editorial.editor.token, item.id, 3)).toBe(
          true,
        );
        expect(
          await catalog.approve(f.editorial.reviewer.token, item.id, 3, true),
        ).toBe(true);
        expect(
          await catalog.publish(f.editorial.editor.token, item.id, 3),
        ).toBe(true);
      }
      const admission = f.programs.enroll(member.token, randomUUID(), intent);
      await blocked(f.pool);
      await writer.query("COMMIT");
      expect(await admission).toEqual({ kind: "stale" });
      expect(f.state.inserts).toBe(0);
      expect(await f.programs.overview()).toMatchObject({
        kind: "ready",
        value: { availability: "course_unavailable" },
      });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await f.close();
    }
  });
  it(`PROGRAM-03/05 fences actual catalog ${operation} behind admission and retains the original receipt`, async () => {
    const f = await ready();
    const pause = gate();
    try {
      const member = await f.member();
      f.state.pause = {
        after: "LOCK TABLE content_versions IN SHARE MODE",
        reached: pause.reached,
        resume: pause.release,
      };
      const admission = f.programs.enroll(member.token, randomUUID(), intent);
      await pause.waiting;
      const change = (async () => {
        if (operation === "retire")
          return f.catalog.retire(f.editorial.editor.token, "FND-001");
        const item = { ...(await reviewedFoundation())[0]!, version: 3 };
        expect(
          await f.catalog.createDraft(f.editorial.editor.token, item),
        ).toBe(true);
        expect(
          await f.catalog.submit(f.editorial.editor.token, item.id, 3),
        ).toBe(true);
        expect(
          await f.catalog.approve(f.editorial.reviewer.token, item.id, 3, true),
        ).toBe(true);
        return f.catalog.publish(f.editorial.editor.token, item.id, 3);
      })();
      await blocked(f.pool);
      pause.resume();
      expect((await admission).kind).toBe("ready");
      expect(await change).toBe(true);
      expect(await f.programs.overview()).toMatchObject({
        kind: "ready",
        value: { availability: "course_unavailable" },
      });
      expect(await f.programs.mine(member.token)).toMatchObject({
        kind: "ready",
        value: { manifest: retainedRequirements() },
      });
    } finally {
      pause.resume();
      await f.close();
    }
  });
}
// The saved requirement remains v1/FND-001v2, regardless of a new catalog release.
function retainedRequirements() {
  return {
    programVersion: 1,
    termVersion: 1,
    lessons: expect.arrayContaining([
      expect.objectContaining({ id: "FND-001", version: 2 }),
    ]),
  };
}
it.each(["rotate", "erase", "deleting"] as const)(
  "PROGRAM-03/05 rechecks current authority after a waiting member %s",
  async (operation) => {
    const f = await ready();
    const writer = await f.pool.connect();
    try {
      const member = await f.member();
      await writer.query("BEGIN");
      if (operation === "rotate")
        await writer.query("UPDATE principals SET token_hash=$1 WHERE id=$2", [
          hash("b".repeat(64)),
          member.id,
        ]);
      else if (operation === "erase")
        await writer.query("DELETE FROM principals WHERE id=$1", [member.id]);
      else
        await writer.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [member.id],
        );
      const admission = f.programs.enroll(member.token, randomUUID(), intent);
      await blocked(f.pool);
      await writer.query("COMMIT");
      expect(await admission).toEqual({ kind: "denied" });
      expect(f.state.inserts).toBe(0);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await f.close();
    }
  },
);
it("PROGRAM-03 denies a member expiring during a real term-lock wait using the unchanged authority deadline", async () => {
  const f = await ready();
  const lock = await f.pool.connect();
  try {
    const member = await f.member();
    await f.pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE id=$1",
      [member.id],
    );
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM local_program_terms FOR UPDATE");
    const admission = f.programs.enroll(member.token, randomUUID(), intent);
    await blocked(f.pool);
    expect(await admission).toEqual({ kind: "denied" });
    await lock.query("COMMIT");
    expect(f.state.inserts).toBe(0);
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    await f.close();
  }
});

it("PROGRAM-03 reports a real catalog lock timeout as unavailable without claiming a closed or empty term", async () => {
  const f = await ready();
  const writer = await f.pool.connect();
  try {
    const member = await f.member();
    await writer.query("BEGIN");
    await writer.query("LOCK TABLE content_versions IN ROW EXCLUSIVE MODE");
    const admission = f.programs.enroll(member.token, randomUUID(), intent);
    await blocked(f.pool);
    expect(await admission).toEqual({ kind: "unavailable" });
    await writer.query("COMMIT");
    expect(f.state.inserts).toBe(0);
    expect(await f.programs.overview()).toMatchObject({
      kind: "ready",
      value: { availability: "ready", remaining: 20 },
    });
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    await f.close();
  }
  // Existing product lock/query limits are 5s; this new observer allows setup/cleanup too.
}, 10000);
it("PROGRAM-01/03 rechecks an administrator role changed while its profile lock waits", async () => {
  const f = await ready();
  const writer = await f.pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      "UPDATE staff_profiles SET role='editor' WHERE principal_id=$1",
      [f.admin.id],
    );
    const closure = f.programs.change(
      f.admin.token,
      "close",
      2,
      PROGRAM_DIGEST,
    );
    await blocked(f.pool);
    await writer.query("COMMIT");
    expect(await closure).toEqual({ kind: "denied" });
    expect(await f.programs.overview()).toMatchObject({
      kind: "ready",
      value: { state: "open" },
    });
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    await f.close();
  }
});
it("PROGRAM-03 treats an actual unavailable fixture database endpoint as an outage, without exposing its cause or granting admission", async () => {
  const f = await ready();
  const unavailable = new Pool({
    host: `/tmp/dne557-unavailable-${randomUUID()}`,
    database: "dne_unavailable_fixture",
    connectionTimeoutMillis: 3000,
  });
  try {
    const member = await f.member();
    const programs = programEnrollmentStore(unavailable, "test");
    expect(await programs.overview()).toEqual({ kind: "unavailable" });
    const application = app(f.members, {
      origin: f.origin,
      secret: f.secret,
      mode: "test",
      programs,
    });
    const publicPage = await request(application)
      .get(PROGRAM_PATH)
      .set("Host", new URL(f.origin).host);
    expect(publicPage.status).toBe(503);
    expect(publicPage.text).toContain("temporarily unavailable");
    const response = await request(application)
      .post(`${PROGRAM_PATH}/enroll`)
      .set("Host", new URL(f.origin).host)
      .set("Origin", f.origin)
      .set("Cookie", `${COOKIE}=${member.token}`)
      .type("form")
      .send({
        ...intent,
        key: randomUUID(),
        confirm: "yes",
        csrf: csrf(member.token, f.secret),
      });
    expect(response.status).toBe(503);
    expect(response.text).not.toMatch(
      /ENOENT|dne557-unavailable|database detail/i,
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::integer n FROM local_program_enrollments",
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await unavailable.end();
    await f.close();
  }
});
it.each(["commit_after", "commit_before", "release_after"] as const)(
  "PROGRAM-03/ENR-04 reports actual PostgreSQL %s uncertainty and inspects without replay",
  async (fault) => {
    const f = await ready();
    try {
      const member = await f.member();
      const key = randomUUID();
      f.state.fault = fault;
      const response = await request(f.server)
        .post(`${PROGRAM_PATH}/enroll`)
        .set("Host", new URL(f.origin).host)
        .set("Origin", f.origin)
        .set("Cookie", `${COOKIE}=${member.token}`)
        .type("form")
        .send({
          ...intent,
          key,
          confirm: "yes",
          csrf: csrf(member.token, f.secret),
        });
      expect(response.status).toBe(503);
      expect(response.text).toContain(key);
      expect(response.text).not.toContain("Invented transport");
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(f.state.lostReplies).toBe(1);
      expect(f.state.inserts).toBe(1);
      const inspection = await f.programs.inspect(member.token, key);
      expect(inspection.kind).toBe("ready");
      if (inspection.kind !== "ready") throw Error("Inspection unavailable");
      expect(Boolean(inspection.value)).toBe(fault !== "commit_before");
      const page = await request(f.server)
        .get(`/my-courses/inspect?key=${key}`)
        .set("Host", new URL(f.origin).host)
        .set("Cookie", `${COOKIE}=${member.token}`);
      expect(page.status).toBe(200);
      expect(f.state.inserts).toBe(1);
      expect(f.state.rollbacksAfterCommit).toBe(0);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::integer n FROM local_program_enrollments",
          )
        ).rows[0].n,
      ).toBe(fault === "commit_before" ? 0 : 1);
    } finally {
      await f.close();
    }
  },
);

it("PROGRAM-15/ENR-06 resumes a new student's exact public choice without implicit enrollment or registration overwrite", async () => {
  const f = await ready();
  try {
    const get = (path: string, cookies?: string) => {
      const call = request(f.server)
        .get(path)
        .set("Host", new URL(f.origin).host);
      return cookies ? call.set("Cookie", cookies) : call;
    };
    const post = (
      path: string,
      cookies: string,
      fields: Record<string, string>,
    ) =>
      request(f.server)
        .post(path)
        .set("Host", new URL(f.origin).host)
        .set("Origin", f.origin)
        .set("Cookie", cookies)
        .type("form")
        .send(fields);
    const publicPage = await get(PROGRAM_PATH);
    expect(publicPage.status).toBe(200);
    const guest = responseCookie(publicPage.headers, COOKIE);
    const token = cookieValue(guest);
    const choice = await post(`${PROGRAM_PATH}/choose`, guest, {
      ...formFields(publicPage.text),
      confirm: "yes",
    });
    expect(choice.status).toBe(200);
    const selected = responseCookie(choice.headers, "dne_program_selection");
    const cookies = `${guest}; ${selected}`;
    expect((await get(`${PROGRAM_PATH}/confirm`, selected)).status).toBe(401);
    const welcome = await get("/", cookies);
    expect(welcome.status).toBe(200);
    const start = await post("/start", cookies, {
      csrf: csrf(token, f.secret),
      background: "explorer",
      goal: "everyday",
    });
    expect(start.status).toBe(303);
    expect(start.headers.location).toBe(`${PROGRAM_PATH}/confirm`);
    const session = await f.members.session(token);
    expect(session.kind).toBe("active");
    await post("/start", cookies, {
      csrf: csrf(token, f.secret),
      background: "technical",
      goal: "build",
    }).expect(303);
    expect(await f.members.session(token)).toMatchObject({
      kind: "active",
      learner: { background: "explorer", goal: "everyday" },
    });
    expect(await f.programs.mine(token)).toEqual({
      kind: "ready",
      value: null,
    });
    expect((await get("/", guest)).headers.location).toBe("/learn");
    expect((await get(`${PROGRAM_PATH}/confirm`, guest)).status).toBe(409);
    expect(
      (
        await get(
          `${PROGRAM_PATH}/confirm`,
          `${guest}; dne_program_selection=tampered`,
        )
      ).status,
    ).toBe(409);
    const form = await get(`${PROGRAM_PATH}/confirm`, cookies);
    expect(form.status).toBe(200);
    const inputs: Record<string, string> = {
      ...formFields(form.text),
      confirm: "yes",
    };
    const foreign = await request(f.server)
      .post(`${PROGRAM_PATH}/enroll`)
      .set("Host", new URL(f.origin).host)
      .set("Origin", "https://foreign.example.invalid")
      .set("Cookie", cookies)
      .type("form")
      .send(inputs);
    expect(foreign.status).toBe(403);
    expect(f.state.inserts).toBe(0);
    expect((await post(`${PROGRAM_PATH}/enroll`, cookies, inputs)).status).toBe(
      303,
    );
    expect((await post(`${PROGRAM_PATH}/enroll`, cookies, inputs)).status).toBe(
      303,
    );
    expect(f.state.inserts).toBe(1);
    expect((await get("/my-courses", cookies)).text).toContain(
      "Local enrollment saved",
    );
    expect(
      (
        await get(
          `/my-courses/inspect?key=${inputs.key}&returnTo=https://foreign.example.invalid/`,
          cookies,
        )
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
it("PROGRAM-15/ENR-07 uses actual email confirmation to return to the same saved account and choice, refusing a different active account", async () => {
  const f = await ready();
  try {
    const owner = await f.member("professional");
    await f.members.save(owner.token, {
      revision: 0,
      instruction: "Invented work before account recovery",
      verification: "Check the same private first work",
      complete: true,
    });
    const original = await f.members.withExerciseRead(
      owner.token,
      (rows) => rows,
    );
    expect(original).toHaveLength(1);
    await f.email.requestAttach(owner.token, "program-student@example.com");
    expect(f.state.delivered).toHaveLength(1);
    const attach = new URL(f.state.delivered[0]!.link).searchParams.get(
      "code",
    )!;
    expect((await f.email.consume(attach, owner.token)).kind).toBe("attached");
    const publicPage = await request(f.server)
      .get(PROGRAM_PATH)
      .set("Host", new URL(f.origin).host);
    const guest = responseCookie(publicPage.headers, COOKIE),
      guestToken = cookieValue(guest);
    const post = (
      path: string,
      cookies: string,
      fields: Record<string, string>,
    ) =>
      request(f.server)
        .post(path)
        .set("Host", new URL(f.origin).host)
        .set("Origin", f.origin)
        .set("Cookie", cookies)
        .type("form")
        .send(fields);
    const choice = await post(`${PROGRAM_PATH}/choose`, guest, {
      ...formFields(publicPage.text),
      confirm: "yes",
    });
    const selected = responseCookie(choice.headers, "dne_program_selection");
    const requestLink = await post("/email/sign-in", guest, {
      csrf: csrf(guestToken, f.secret),
      email: "program-student@example.com",
    });
    expect(requestLink.status).toBe(200);
    await vi.waitFor(() => expect(f.state.delivered).toHaveLength(2), {
      timeout: 2000,
      interval: 10,
    });
    const code = new URL(f.state.delivered[1]!.link).searchParams.get("code")!;
    const other = await f.member("technical");
    const denied = await post(
      "/email/confirm",
      `${COOKIE}=${other.token}; ${selected}`,
      { code },
    );
    expect(denied.status).toBe(409);
    expect(await f.members.session(other.token)).toMatchObject({
      kind: "active",
      learner: { id: other.id },
    });
    const confirmation = await request(f.server)
      .get(`/email/confirm?code=${code}`)
      .set("Host", new URL(f.origin).host)
      .set("Cookie", `${guest}; ${selected}`);
    expect(confirmation.status).toBe(200);
    const signedIn = await post("/email/confirm", `${guest}; ${selected}`, {
      code,
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.location).toBe(`${PROGRAM_PATH}/confirm`);
    const recovered = responseCookie(signedIn.headers, COOKIE),
      recoveredToken = cookieValue(recovered);
    expect(recoveredToken !== owner.token).toBe(true);
    expect(await f.programs.mine(owner.token)).toEqual({ kind: "denied" });
    expect(await f.members.session(recoveredToken)).toMatchObject({
      kind: "active",
      learner: { id: owner.id },
    });
    expect(
      await f.members.withExerciseRead(recoveredToken, (rows) => rows),
    ).toEqual(original);
    expect(await f.programs.mine(recoveredToken)).toEqual({
      kind: "ready",
      value: null,
    });
    expect((await post("/email/confirm", recovered, { code })).status).toBe(
      409,
    );
    const form = await request(f.server)
      .get(`${PROGRAM_PATH}/confirm`)
      .set("Host", new URL(f.origin).host)
      .set("Cookie", `${recovered}; ${selected}`);
    expect(form.status).toBe(200);
    expect(
      (
        await post(`${PROGRAM_PATH}/enroll`, `${recovered}; ${selected}`, {
          ...formFields(form.text),
          confirm: "yes",
        })
      ).status,
    ).toBe(303);
    expect(f.state.inserts).toBe(1);
    expect(
      await f.members.withExerciseRead(recoveredToken, (rows) => rows),
    ).toEqual(original);
    expect(
      (
        await request(f.server)
          .get("/")
          .set("Host", new URL(f.origin).host)
          .set("Cookie", recovered)
      ).headers.location,
    ).toBe("/learn");
  } finally {
    await f.close();
  }
});
