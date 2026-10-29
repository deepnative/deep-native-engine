import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { expect, it, vi } from "vitest";
import type { Store } from "../../src/store.ts";
import { mountProgramRoutes } from "../../src/program-routes.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import {
  PROGRAM_CONFIRM_PATH,
  PROGRAM_DIGEST,
  PROGRAM_MANIFEST,
  PROGRAM_PATH,
  disabledProgramStore,
  type ProgramOverview,
  type ProgramReceipt,
  type ProgramResult,
} from "../../src/program-values.ts";
import { issueProgramSelection } from "../../src/program-selection.ts";
import { withLoopback } from "../support/loopback-server.ts";

const bearer = "a".repeat(64),
  secret = "invented-program-routes-secret";
const id = "10aba371-5534-468f-9a8b-e6fa1ea406b1";
const key = "13a81b72-3651-4426-888b-c7c45a41d919";
const selected = () => `dne_program_selection=${issueProgramSelection(secret)}`;
async function fixture() {
  const pack = await reviewedFoundation();
  const overview: ProgramOverview = {
    manifest: structuredClone(PROGRAM_MANIFEST),
    digest: PROGRAM_DIGEST,
    revision: 2,
    state: "open",
    availability: "ready",
    remaining: 20,
    lessons: pack.map(({ id, version, title }) => ({ id, version, title })),
  };
  const receipt: ProgramReceipt = {
    id,
    enrolledAt: "2026-10-29T09:00:00.000Z",
    manifest: structuredClone(PROGRAM_MANIFEST),
    digest: PROGRAM_DIGEST,
    activity: [],
  };
  const reads = {
    overview: vi
      .fn<() => Promise<ProgramResult<ProgramOverview>>>()
      .mockResolvedValue({ kind: "ready", value: overview }),
    mine: vi
      .fn<() => Promise<ProgramResult<ProgramReceipt | null>>>()
      .mockResolvedValue({ kind: "ready", value: null }),
    inspect: vi
      .fn<() => Promise<ProgramResult<ProgramReceipt | null>>>()
      .mockResolvedValue({ kind: "ready", value: receipt }),
    enroll: vi
      .fn<() => Promise<ProgramResult<ProgramReceipt>>>()
      .mockResolvedValue({ kind: "ready", value: receipt }),
    admin: vi
      .fn<() => Promise<ProgramResult<ProgramOverview>>>()
      .mockResolvedValue({ kind: "ready", value: overview }),
    change: vi
      .fn<() => Promise<ProgramResult<ProgramOverview>>>()
      .mockResolvedValue({ kind: "ready", value: overview }),
  };
  const session = vi.fn().mockResolvedValue({ kind: "active" });
  const app = express();
  app.use(
    express.urlencoded({ extended: false }),
    express.json(),
    cookieParser(),
  );
  app.use((_req, res, next) => {
    res.locals.token = bearer;
    next();
  });
  mountProgramRoutes(
    app,
    { session } as unknown as Store,
    { ...disabledProgramStore(), ...reads },
    "https://127.0.0.1:3000",
    secret,
  );
  return { app, reads, session, overview, receipt };
}
const fields = () => ({
  confirm: "yes",
  key,
  programVersion: "1",
  termVersion: "1",
  revision: "2",
  digest: PROGRAM_DIGEST,
});
it("PROGRAM-01/15 exposes honest source outcomes, an explicit public choice and a separate confirmation", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    const publicView = await request(server).get(PROGRAM_PATH).expect(200);
    expect(publicView.text).toContain("Local enrollment simulation");
    expect(publicView.text).toContain("not a full academic term");
    expect(publicView.text).toContain("Choose local program");
    expect(publicView.headers["set-cookie"]![0]).toContain("HttpOnly");
    expect(publicView.headers["set-cookie"]![0]).toContain("Secure");
    expect(
      (
        await request(server)
          .get("/programs")
          .set("Cookie", `dne_preview=${bearer}`)
          .expect(200)
      ).headers["set-cookie"],
    ).toBeUndefined();
    const choice = await request(server)
      .post(`${PROGRAM_PATH}/choose`)
      .type("form")
      .send({ confirm: "yes" })
      .expect(303);
    expect(choice.headers.location).toBe(PROGRAM_CONFIRM_PATH);
    expect(choice.headers["set-cookie"]![0]).toMatch(
      /HttpOnly; Secure; SameSite=Lax/,
    );
    expect(f.reads.enroll).not.toHaveBeenCalled();
    const form = await request(server)
      .get(PROGRAM_CONFIRM_PATH)
      .set("Cookie", selected())
      .expect(200);
    expect(form.text).toContain("Confirm local enrollment");
    expect(form.text).toContain('name="key"');
    expect(f.session).toHaveBeenCalledWith(bearer, "account");
    expect(f.reads.enroll).not.toHaveBeenCalled();
  });
});
it("PROGRAM-03/15 refuses stale choices, malformed forms and missing or expired account context", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    await request(server).get(`${PROGRAM_PATH}?unexpected=yes`).expect(400);
    await request(server)
      .post(`${PROGRAM_PATH}/choose?unexpected=yes`)
      .send({ confirm: "yes" })
      .expect(400);
    await request(server)
      .post(`${PROGRAM_PATH}/choose`)
      .type("form")
      .send({ extra: "yes" })
      .expect(400);
    await request(server)
      .post(`${PROGRAM_PATH}/choose`)
      .type("form")
      .send({ confirm: "no" })
      .expect(422);
    f.overview.availability = "closed";
    expect(
      (await request(server).get(PROGRAM_PATH).expect(200)).text,
    ).not.toContain("Choose local program</button>");
    await request(server)
      .post(`${PROGRAM_PATH}/choose`)
      .type("form")
      .send({ confirm: "yes" })
      .expect(409);
    await request(server).get(PROGRAM_CONFIRM_PATH).expect(409);
    await request(server)
      .get(PROGRAM_CONFIRM_PATH)
      .set("Cookie", selected())
      .expect(409);
    f.session.mockResolvedValue({ kind: "expired" });
    const expired = await request(server)
      .get(PROGRAM_CONFIRM_PATH)
      .set("Cookie", selected())
      .expect(401);
    expect(expired.text).toContain("15 minutes");
    expect(
      (await request(server).get("/my-courses").expect(401)).text,
    ).toContain("Choose the public program again");
    f.session.mockRejectedValue(Error("Private account detail"));
    const failed = await request(server).get("/my-courses").expect(503);
    expect(failed.text).not.toContain("Private account detail");
    expect(f.reads.enroll).not.toHaveBeenCalled();
  });
});
it("PROGRAM-01/03 keeps source and account outages distinct from unavailable enrollment", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    f.reads.overview.mockResolvedValue({ kind: "unavailable" });
    await request(server).get(PROGRAM_PATH).expect(503);
    await request(server)
      .post(`${PROGRAM_PATH}/choose`)
      .type("form")
      .send({ confirm: "yes" })
      .expect(503);
    await request(server)
      .get(PROGRAM_CONFIRM_PATH)
      .set("Cookie", selected())
      .expect(503);
    f.reads.overview.mockResolvedValue({ kind: "ready", value: f.overview });
    f.session.mockRejectedValue(Error("Private session detail"));
    expect(
      (
        await request(server)
          .post(`${PROGRAM_PATH}/choose`)
          .type("form")
          .send({ confirm: "yes" })
          .expect(503)
      ).text,
    ).not.toContain("Private session detail");
    f.session.mockResolvedValue({ kind: "new" });
    expect(
      (
        await request(server)
          .post(`${PROGRAM_PATH}/choose`)
          .type("form")
          .send({ confirm: "yes" })
          .expect(200)
      ).text,
    ).toContain("No enrollment has been created");
  });
});
it("PROGRAM-02/03 requires explicit exact input and never automatically retries an uncertain write", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    await request(server)
      .post(`${PROGRAM_PATH}/enroll`)
      .type("form")
      .send({ ...fields(), confirm: "no" })
      .expect(422);
    await request(server)
      .post(`${PROGRAM_PATH}/enroll`)
      .type("form")
      .send({ ...fields(), key: "not-a-key" })
      .expect(422);
    await request(server)
      .post(`${PROGRAM_PATH}/enroll`)
      .type("form")
      .send({ ...fields(), revision: "2x" })
      .expect(422);
    expect(f.reads.enroll).not.toHaveBeenCalled();
    const success = await request(server)
      .post(`${PROGRAM_PATH}/enroll`)
      .type("form")
      .send(fields())
      .expect(303);
    expect(success.headers.location).toBe("/my-courses");
    expect(f.reads.enroll).toHaveBeenLastCalledWith(bearer, key, {
      programVersion: 1,
      termVersion: 1,
      revision: 2,
      digest: PROGRAM_DIGEST,
    });
    for (const kind of [
      "denied",
      "unavailable",
      "stale",
      "full",
      "conflict",
    ] as const) {
      f.reads.enroll.mockResolvedValue({ kind });
      const response = await request(server)
        .post(`${PROGRAM_PATH}/enroll`)
        .type("form")
        .send(fields())
        .expect(kind === "denied" ? 401 : kind === "unavailable" ? 503 : 409);
      if (kind === "unavailable") {
        expect(response.text).toContain(key);
        expect(response.text).toContain(
          'method="get" action="/my-courses/inspect"',
        );
        expect(response.headers["content-disposition"]).toBeUndefined();
      }
    }
    expect(f.reads.enroll).toHaveBeenCalledTimes(6);
  });
});
it("PROGRAM-03/05 allows only current own receipt/key inspection and explicitly whitelists downloads", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    await request(server).get("/my-courses/inspect").expect(400);
    await request(server)
      .get(`/my-courses/inspect?key=${key}&extra=1`)
      .expect(400);
    const inspected = await request(server)
      .get(`/my-courses/inspect?key=${key}`)
      .expect(200);
    expect(inspected.text).toContain("Your accepted receipt is retained");
    expect(f.reads.inspect).toHaveBeenCalledWith(bearer, key);
    f.reads.inspect.mockResolvedValue({ kind: "ready", value: null });
    expect(
      (await request(server).get(`/my-courses/inspect?key=${key}`).expect(200))
        .text,
    ).toContain("No receipt was found");
    for (const kind of ["denied", "unavailable"] as const) {
      f.reads.inspect.mockResolvedValue({ kind });
      await request(server)
        .get(`/my-courses/inspect?key=${key}`)
        .expect(kind === "denied" ? 401 : 503);
      f.reads.mine.mockResolvedValue({ kind });
      await request(server)
        .get("/my-courses")
        .expect(kind === "denied" ? 401 : 503);
      await request(server)
        .get(PROGRAM_CONFIRM_PATH)
        .set("Cookie", selected())
        .expect(kind === "denied" ? 401 : 503);
    }
    f.reads.mine.mockResolvedValue({ kind: "ready", value: null });
    expect(
      (await request(server).get("/my-courses").expect(200)).text,
    ).toContain("No local enrollment is recorded");
    await request(server).get(`/my-courses/${id}`).expect(404);
    f.reads.mine.mockResolvedValue({
      kind: "ready",
      value: {
        ...f.receipt,
        privateNote: "Private database detail",
        activity: [
          { id: "FND-001", version: 2, started: true, selfAssessed: true },
        ],
      } as ProgramReceipt,
    });
    expect(
      (await request(server).get(PROGRAM_CONFIRM_PATH).expect(303)).headers
        .location,
    ).toBe("/my-courses");
    const dashboard = await request(server).get("/my-courses").expect(200);
    expect(dashboard.text).toContain("Self-assessed activity recorded");
    expect(dashboard.text).toContain("Open current matching lesson");
    await request(server).get("/my-courses/bad-id").expect(404);
    await request(server)
      .get("/my-courses/13a81b72-3651-4426-888b-c7c45a41d919/download")
      .expect(404);
    const json = await request(server)
      .get(`/my-courses/${id}/download`)
      .expect(200);
    expect(json.text).not.toContain("Private database detail");
    expect(json.headers["content-disposition"]).toBe(
      'attachment; filename="program-enrollment.json"',
    );
    expect(json.headers["cache-control"]).toBe("no-store");
    f.overview.availability = "course_unavailable";
    const stale = await request(server).get(`/my-courses/${id}`).expect(200);
    expect(stale.text).toContain("Earlier activity is retained");
    expect(stale.text).not.toContain("Open current matching lesson");
    f.reads.overview.mockResolvedValue({ kind: "unavailable" });
    expect(
      (await request(server).get("/my-courses").expect(200)).text,
    ).toContain("temporarily unavailable");
    expect(f.reads.enroll).not.toHaveBeenCalled();
  });
});
it("PROGRAM-01/03 requires exact explicit admin commands and shows current state without replay", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    f.overview.state = "not_open";
    f.overview.revision = 1;
    expect(
      (await request(server).get("/operator/programs").expect(200)).text,
    ).toContain("Open local term");
    f.overview.state = "open";
    f.overview.revision = 2;
    expect(
      (await request(server).get("/operator/programs").expect(200)).text,
    ).toContain("Close local term");
    f.overview.state = "closed";
    f.overview.revision = 3;
    expect(
      (await request(server).get("/operator/programs").expect(200)).text,
    ).toContain("No reopening");
    for (const kind of ["denied", "unavailable"] as const) {
      f.reads.admin.mockResolvedValue({ kind });
      await request(server)
        .get("/operator/programs")
        .expect(kind === "denied" ? 403 : 503);
    }
    await request(server)
      .post("/operator/programs/open")
      .type("form")
      .send({ confirm: "no" })
      .expect(422);
    await request(server)
      .post("/operator/programs/open")
      .type("form")
      .send({ confirm: "yes", revision: "bad", digest: PROGRAM_DIGEST })
      .expect(422);
    await request(server)
      .post("/operator/programs/open")
      .type("form")
      .send({ confirm: "yes", revision: "1" })
      .expect(422);
    for (const action of ["open", "close"]) {
      const fields = { confirm: "yes", revision: "1", digest: PROGRAM_DIGEST };
      await request(server)
        .post(`/operator/programs/${action}`)
        .type("form")
        .send(fields)
        .expect(303);
      for (const kind of ["denied", "unavailable", "stale"] as const) {
        f.reads.change.mockResolvedValueOnce({ kind });
        await request(server)
          .post(`/operator/programs/${action}`)
          .type("form")
          .send(fields)
          .expect(kind === "denied" ? 403 : kind === "unavailable" ? 503 : 409);
      }
    }
  });
});

it("PROGRAM-03/15 refuses missing bodies, unrelated admin queries and expired write/inspection sessions before store actions", async () => {
  const f = await fixture();
  await withLoopback(f.app, async (server) => {
    await request(server).post(`${PROGRAM_PATH}/choose`).expect(400);
    await request(server)
      .post(`${PROGRAM_PATH}/choose`)
      .send(["not-a-form"])
      .expect(400);
    await request(server).get("/operator/programs?unexpected=1").expect(400);
    await request(server)
      .post("/operator/programs/open?unexpected=1")
      .type("form")
      .send({ confirm: "yes" })
      .expect(400);
    await request(server)
      .post("/operator/programs/open")
      .type("form")
      .send({ confirm: "yes", digest: PROGRAM_DIGEST })
      .expect(422);
    await request(server)
      .post(`${PROGRAM_PATH}/enroll?unexpected=1`)
      .type("form")
      .send(fields())
      .expect(400);
    f.session.mockResolvedValue({ kind: "expired" });
    await request(server)
      .post(`${PROGRAM_PATH}/enroll`)
      .type("form")
      .send(fields())
      .expect(401);
    await request(server).get(`/my-courses/inspect?key=${key}`).expect(401);
    expect(f.reads.enroll).not.toHaveBeenCalled();
    expect(f.reads.inspect).not.toHaveBeenCalled();
    expect(f.reads.change).not.toHaveBeenCalled();
  });
});
