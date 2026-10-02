import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const feedback = workflowFeedbackStore(pool);
const token = () => randomBytes(32).toString("hex");

async function member(background: "explorer" | "professional" | "technical") {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("withholds retained private feedback over HTTP when workspace deletion is pending", async () => {
  const owner = await member("explorer");
  expect(
    await feedback.save(
      owner.token,
      "WF-001",
      1,
      "Invented retained private note",
      0,
    ),
  ).toBe(true);
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [owner.id],
  );
  const response = await request(
    app(db, {
      origin: "http://localhost",
      secret: "test-secret",
      workflowFeedback: feedback,
    }),
  )
    .get("/workflow-feedback/WF-001")
    .set("Host", "localhost")
    .set("Cookie", `dne_preview=${owner.token}`);
  expect({
    status: response.status,
    disclosed: response.text.includes("Invented retained private note"),
  }).toEqual({ status: 403, disclosed: false });
  expect(await feedback.list(owner.token)).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT note FROM workflow_feedback WHERE member_id=$1",
        [owner.id],
      )
    ).rows,
  ).toEqual([{ note: "Invented retained private note" }]);
});

it("keeps versioned feedback private across three learner backgrounds and handles conflicting writes", async () => {
  const people = await Promise.all([
    member("explorer"),
    member("professional"),
    member("technical"),
  ]);
  for (const person of people) {
    expect(
      await feedback.save(
        person.token,
        "WF-001",
        1,
        "  Invented workflow detail  ",
        0,
      ),
    ).toBe(true);
    expect(await feedback.list(person.token)).toMatchObject([
      {
        workflowId: "WF-001",
        workflowVersion: 1,
        note: "Invented workflow detail",
        revision: 1,
      },
    ]);
  }
  const owner = people[0]!;
  const other = people[1]!;
  const concurrent = await Promise.all([
    feedback.save(owner.token, "WF-001", 1, "First correction", 1),
    feedback.save(owner.token, "WF-001", 1, "Second correction", 1),
  ]);
  expect(concurrent.sort()).toEqual([false, true]);
  expect(await feedback.list(owner.token)).toMatchObject([{ revision: 2 }]);
  expect(await feedback.list(other.token)).toMatchObject([
    { note: "Invented workflow detail", revision: 1 },
  ]);
  expect(await feedback.withdraw(other.token, "WF-001", 1, 2)).toBe(false);
  expect(await feedback.withdraw(owner.token, "WF-001", 1, 1)).toBe(false);
  expect(await feedback.withdraw(owner.token, "WF-001", 1, 2)).toBe(true);
  expect(await feedback.list(owner.token)).toEqual([]);
  expect(await feedback.list(other.token)).toHaveLength(1);
});

it("rejects unknown versions and staff, revocation and expiry while retaining only owner export", async () => {
  const owner = await member("professional");
  const outsider = await member("technical");
  const staff = token();
  await authorizationStore(pool).provisionStaff(
    staff,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  expect(await feedback.save(owner.token, "WF-999", 1, "Invented", 0)).toBe(
    false,
  );
  expect(await feedback.save(owner.token, "WF-001", 2, "Invented", 0)).toBe(
    false,
  );
  expect(await feedback.save(staff, "WF-001", 1, "Invented", 0)).toBe(false);
  expect(await feedback.list(staff)).toBeNull();
  expect(await feedback.save(owner.token, "WF-001", 1, "Invented", 0)).toBe(
    true,
  );
  const own = await memberExportStore(pool).exportOwned(owner.token);
  expect(own).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v14",
      records: {
        workflowFeedback: [
          { workflowId: "WF-001", workflowVersion: 1, note: "Invented" },
        ],
      },
    },
  });
  const unrelated = await memberExportStore(pool).exportOwned(outsider.token);
  expect(unrelated).toMatchObject({
    kind: "ready",
    payload: { records: { workflowFeedback: [] } },
  });
  await pool.query(
    `UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [owner.id],
  );
  expect(await feedback.list(owner.token)).toBeNull();
  expect(await feedback.withdraw(owner.token, "WF-001", 1, 1)).toBe(false);
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    owner.id,
  ]);
  await pool.query(
    `UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1`,
    [owner.id],
  );
  expect(await feedback.list(owner.token)).toBeNull();
  expect(await feedback.save(owner.token, "WF-001", 1, "Changed", 1)).toBe(
    false,
  );
  await pool.query("DELETE FROM learners WHERE id=$1", [owner.id]);
  expect(
    (
      await pool.query("SELECT 1 FROM workflow_feedback WHERE member_id=$1", [
        owner.id,
      ])
    ).rowCount,
  ).toBe(0);
});

it("shows retained historical versions without silently copying a note to the current file", async () => {
  const owner = await member("explorer");
  await pool.query(
    `INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note)
     VALUES($1,'WF-002',2,'Invented historical version note')`,
    [owner.id],
  );
  expect(await feedback.list(owner.token)).toMatchObject([
    {
      workflowId: "WF-002",
      workflowVersion: 2,
      note: "Invented historical version note",
    },
  ]);
  expect(await feedback.save(owner.token, "WF-002", 2, "Changed", 1)).toBe(
    false,
  );
  expect(await feedback.save(owner.token, "WF-002", 1, "Current note", 0)).toBe(
    true,
  );
  expect(await feedback.list(owner.token)).toHaveLength(2);
  expect(await feedback.withdraw(owner.token, "WF-002", 2, 1)).toBe(true);
  expect(await feedback.list(owner.token)).toMatchObject([
    { workflowVersion: 1, note: "Current note" },
  ]);
});

async function waitUntil(check: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

it.each([
  [0, "principal"],
  [1, "principal"],
  [0, "workspace"],
  [1, "workspace"],
  [0, "unique-key"],
  [1, "feedback"],
] as const)(
  "rolls back revision %i feedback save when the session expires during an observed %s wait",
  async (revision, boundary) => {
    const owner = await member("professional");
    if (revision === 1)
      expect(
        await feedback.save(
          owner.token,
          "WF-001",
          1,
          "Original invented note",
          0,
        ),
      ).toBe(true);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+INTERVAL '1 second' WHERE id=$1",
      [owner.id],
    );
    const blocker = await pool.connect();
    const writer = await pool.connect();
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid as number;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid as number;
    const controlled = workflowFeedbackStore({
      query: writer.query.bind(writer),
      connect: async () => ({ query: writer.query.bind(writer), release() {} }),
    } as unknown as import("pg").Pool);
    let writing: ReturnType<typeof feedback.save> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        boundary === "principal"
          ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
          : boundary === "workspace"
            ? "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE"
            : boundary === "unique-key"
              ? "INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note) VALUES($1,'WF-001',1,'Uncommitted invented note')"
              : "SELECT member_id FROM workflow_feedback WHERE member_id=$1 FOR UPDATE",
        [owner.id],
      );
      writing = controlled.save(
        owner.token,
        "WF-001",
        1,
        "Late invented note",
        revision,
      );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
              [blockerPid, writerPid],
            )
          ).rows[0].blocked,
        "Save never waited for the controlled lock",
      );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
              [owner.id],
            )
          ).rows[0].expired,
        "Session never expired during the wait",
      );
      // Rollback the competing insert so this save actually inserts after
      // its unique-key wait, exercising the post-write expiry rollback.
      await blocker.query(boundary === "unique-key" ? "ROLLBACK" : "COMMIT");
      const result = await writing;
      const retained = (
        await pool.query(
          "SELECT note,revision FROM workflow_feedback WHERE member_id=$1",
          [owner.id],
        )
      ).rows;
      expect({ result, retained }).toEqual({
        result: false,
        retained:
          revision === 0
            ? []
            : [{ note: "Original invented note", revision: 1 }],
      });
    } finally {
      await blocker.query("ROLLBACK");
      if (writing) await Promise.allSettled([writing]);
      blocker.release();
      writer.release();
    }
  },
  15_000,
);

it.each([0, 1])(
  "denies revision %i saves after queued revocation or workspace deletion wins",
  async (revision) => {
    for (const boundary of ["revoked", "deleting"] as const) {
      const owner = await member("explorer");
      if (revision === 1)
        expect(
          await feedback.save(
            owner.token,
            "WF-001",
            1,
            "Original invented note",
            0,
          ),
        ).toBe(true);
      const blocker = await pool.connect();
      const writer = await pool.connect();
      const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const controlled = workflowFeedbackStore({
        connect: async () => ({
          query: writer.query.bind(writer),
          release() {},
        }),
      } as unknown as import("pg").Pool);
      let writing: ReturnType<typeof feedback.save> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          boundary === "revoked"
            ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
            : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
          [owner.id],
        );
        writing = controlled.save(
          owner.token,
          "WF-001",
          1,
          "Denied invented note",
          revision,
        );
        await waitUntil(
          async () =>
            (
              await pool.query(
                "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
                [blockerPid, writerPid],
              )
            ).rows[0].blocked,
          "Save did not wait for authorization boundary",
        );
        await blocker.query("COMMIT");
        expect(await writing).toBe(false);
        expect(
          (
            await pool.query(
              "SELECT note,revision FROM workflow_feedback WHERE member_id=$1",
              [owner.id],
            )
          ).rows,
        ).toEqual(
          revision === 0
            ? []
            : [{ note: "Original invented note", revision: 1 }],
        );
      } finally {
        await blocker.query("ROLLBACK");
        if (writing) await Promise.allSettled([writing]);
        blocker.release();
        writer.release();
      }
    }
  },
);

it("retains feedback on save transport failures and releases authorization locks", async () => {
  const owner = await member("technical");
  expect(
    await feedback.save(owner.token, "WF-001", 1, "Original invented note", 0),
  ).toBe(true);
  const client = await pool.connect();
  const controlled = workflowFeedbackStore({
    connect: async () => ({
      async query(sql: string, values?: unknown[]) {
        const result = await client.query(sql, values);
        if (sql.startsWith("UPDATE workflow_feedback"))
          throw new Error("Simulated post-write transport failure");
        return result;
      },
      release() {},
    }),
  } as unknown as import("pg").Pool);
  try {
    expect(
      await controlled.save(
        owner.token,
        "WF-001",
        1,
        "Failed invented note",
        1,
      ),
    ).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT note,revision FROM workflow_feedback WHERE member_id=$1",
          [owner.id],
        )
      ).rows,
    ).toEqual([{ note: "Original invented note", revision: 1 }]);
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL lock_timeout='1s'");
      await probe.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        owner.id,
      ]);
      await probe.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
        [owner.id],
      );
      await probe.query("ROLLBACK");
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
  } finally {
    client.release();
  }
});

it("allows only one initial save and cannot correct another member's feedback", async () => {
  const owner = await member("technical");
  const other = await member("explorer");
  expect(
    (
      await Promise.all([
        feedback.save(owner.token, "WF-001", 1, "Invented first", 0),
        feedback.save(owner.token, "WF-001", 1, "Invented second", 0),
      ])
    ).sort(),
  ).toEqual([false, true]);
  const retained = await feedback.list(owner.token);
  expect(retained).toHaveLength(1);
  expect(retained?.[0]?.revision).toBe(1);
  expect(
    await feedback.save(
      other.token,
      "WF-001",
      1,
      "Invented cross-member correction",
      1,
    ),
  ).toBe(false);
  expect(await feedback.list(other.token)).toEqual([]);
  expect(await feedback.list(owner.token)).toEqual(retained);
});

it.each([
  [0, "before"],
  [1, "before"],
  [0, "after"],
  [1, "after"],
] as const)(
  "reports uncertainty for revision %i save when transport fails %s commit",
  async (revision, timing) => {
    const owner = await member("professional");
    if (revision === 1) {
      expect(
        await feedback.save(
          owner.token,
          "WF-001",
          1,
          "Original invented note",
          0,
        ),
      ).toBe(true);
    }
    const client = await pool.connect();
    const controlled = workflowFeedbackStore({
      connect: async () => ({
        async query(sql: string, values?: unknown[]) {
          if (sql === "COMMIT" && timing === "before")
            throw new Error("Simulated commit transport failure");
          const result = await client.query(sql, values);
          if (sql === "COMMIT")
            throw new Error("Simulated lost commit acknowledgement");
          return result;
        },
        release() {},
      }),
    } as unknown as import("pg").Pool);
    try {
      const result = await controlled.save(
        owner.token,
        "WF-001",
        1,
        "Committed invented note",
        revision,
      );
      const retained = (
        await pool.query(
          "SELECT note,revision FROM workflow_feedback WHERE member_id=$1",
          [owner.id],
        )
      ).rows;
      expect({ result, retained }).toEqual({
        result: "uncertain",
        retained:
          timing === "after"
            ? [{ note: "Committed invented note", revision: revision + 1 }]
            : revision === 1
              ? [{ note: "Original invented note", revision: 1 }]
              : [],
      });
      expect(await feedback.list(owner.token)).toMatchObject(retained);
      expect(
        await feedback.save(
          owner.token,
          "WF-001",
          1,
          "Invented recovery attempt",
          revision,
        ),
      ).toBe(timing === "before");
      if (timing === "after")
        expect(await feedback.list(owner.token)).toMatchObject(retained);
    } finally {
      client.release();
    }
  },
);

function feedbackPage(value: string, backend = feedback, id = "WF-001") {
  return request(
    app(db, {
      origin: "http://localhost",
      secret: "test-secret",
      workflowFeedback: backend,
    }),
  )
    .get(`/workflow-feedback/${id}`)
    .set("Host", "localhost")
    .set("Cookie", `dne_preview=${value}`);
}

it("distinguishes valid empty and historical pages from content-free denial for every workflow ID", async () => {
  const owner = await member("professional");
  const other = await member("technical");
  expect(await feedback.list(token())).toBeNull();
  expect(await feedback.list(owner.token)).toEqual([]);
  expect((await feedbackPage(owner.token)).status).toBe(200);
  expect((await feedbackPage(owner.token, feedback, "WF-999")).status).toBe(
    404,
  );
  await pool.query(
    "INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note) VALUES($1,'WF-998',2,'Invented historical-only private note')",
    [owner.id],
  );
  const historical = await feedbackPage(owner.token, feedback, "WF-998");
  expect(historical.status).toBe(200);
  expect(historical.text).toContain("Invented historical-only private note");
  expect((await feedbackPage(other.token, feedback, "WF-998")).status).toBe(
    404,
  );
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [owner.id],
  );
  let deniedBody: string | undefined;
  for (const id of ["WF-001", "WF-998", "WF-999"]) {
    const denied = await feedbackPage(owner.token, feedback, id);
    expect(denied.status).toBe(403);
    expect(denied.text).toContain("Feedback unavailable");
    expect(denied.text).not.toMatch(
      /Invented historical|workflow_version|textarea|revision/,
    );
    if (deniedBody !== undefined) expect(denied.text).toBe(deniedBody);
    deniedBody = denied.text;
  }
  expect((await feedbackPage(other.token)).status).toBe(200);
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    other.id,
  ]);
  expect(await feedback.list(other.token)).toBeNull();
  expect((await feedbackPage(other.token)).status).toBe(403);
});

async function blockedBy(blocker: number, waiter: number) {
  return (
    await pool.query(
      "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
      [blocker, waiter],
    )
  ).rows[0].blocked as boolean;
}

it.each(["principal", "workspace", "query"] as const)(
  "withholds a read that expires during an observed %s wait",
  async (boundary) => {
    const owner = await member("explorer");
    expect(
      await feedback.save(
        owner.token,
        "WF-001",
        1,
        "Invented expiring private note",
        0,
      ),
    ).toBe(true);
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [owner.id],
    );
    const blocker = await pool.connect();
    const reader = await pool.connect();
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const readerPid = (await reader.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const controlled = workflowFeedbackStore({
      connect: async () => ({ query: reader.query.bind(reader), release() {} }),
    } as unknown as import("pg").Pool);
    let reading: ReturnType<typeof feedback.list> | undefined;
    try {
      await blocker.query("BEGIN");
      if (boundary === "query")
        await blocker.query(
          "LOCK TABLE workflow_feedback IN ACCESS EXCLUSIVE MODE",
        );
      else
        await blocker.query(
          boundary === "principal"
            ? "SELECT id FROM principals WHERE id=$1 FOR UPDATE"
            : "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
          [owner.id],
        );
      reading = controlled.list(owner.token);
      await waitUntil(
        () => blockedBy(blockerPid, readerPid),
        "Read did not reach controlled wait",
      );
      await waitUntil(
        async () =>
          (
            await pool.query(
              "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
              [owner.id],
            )
          ).rows[0].expired,
        "Session did not expire during read wait",
      );
      await blocker.query("COMMIT");
      expect(await reading).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT note FROM workflow_feedback WHERE member_id=$1",
            [owner.id],
          )
        ).rows,
      ).toEqual([{ note: "Invented expiring private note" }]);
    } finally {
      await blocker.query("ROLLBACK");
      if (reading) await Promise.allSettled([reading]);
      blocker.release();
      reader.release();
    }
  },
  15_000,
);

it.each(["revoked", "deleting"] as const)(
  "withholds a read when %s invalidation wins",
  async (boundary) => {
    const owner = await member("technical");
    expect(
      await feedback.save(
        owner.token,
        "WF-001",
        1,
        "Invented retained private note",
        0,
      ),
    ).toBe(true);
    const blocker = await pool.connect();
    const reader = await pool.connect();
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const readerPid = (await reader.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const controlled = workflowFeedbackStore({
      connect: async () => ({ query: reader.query.bind(reader), release() {} }),
    } as unknown as import("pg").Pool);
    let reading: ReturnType<typeof feedback.list> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        boundary === "revoked"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
          : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
      reading = controlled.list(owner.token);
      await waitUntil(
        () => blockedBy(blockerPid, readerPid),
        "Read did not wait behind invalidation",
      );
      await blocker.query("COMMIT");
      expect(await reading).toBeNull();
      expect(await feedback.list(owner.token)).toBeNull();
    } finally {
      await blocker.query("ROLLBACK");
      if (reading) await Promise.allSettled([reading]);
      blocker.release();
      reader.release();
    }
  },
);

it.each(["revoked", "deleting"] as const)(
  "completes a valid read before queued %s invalidation",
  async (boundary) => {
    const owner = await member("professional");
    expect(
      await feedback.save(
        owner.token,
        "WF-001",
        1,
        "Invented valid private note",
        0,
      ),
    ).toBe(true);
    const tableBlocker = await pool.connect();
    const reader = await pool.connect();
    const invalidator = await pool.connect();
    const tablePid = (
      await tableBlocker.query("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const readerPid = (await reader.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const invalidatorPid = (
      await invalidator.query("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const controlled = workflowFeedbackStore({
      connect: async () => ({ query: reader.query.bind(reader), release() {} }),
    } as unknown as import("pg").Pool);
    let reading: ReturnType<typeof feedback.list> | undefined;
    let invalidating: Promise<unknown> | undefined;
    try {
      await tableBlocker.query("BEGIN");
      await tableBlocker.query(
        "LOCK TABLE workflow_feedback IN ACCESS EXCLUSIVE MODE",
      );
      reading = controlled.list(owner.token);
      await waitUntil(
        () => blockedBy(tablePid, readerPid),
        "Read did not acquire authorization before query wait",
      );
      invalidating = invalidator.query(
        boundary === "revoked"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
          : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
      await waitUntil(
        () => blockedBy(readerPid, invalidatorPid),
        "Invalidation was not serialized behind read",
      );
      await tableBlocker.query("COMMIT");
      expect(await reading).toMatchObject([
        { note: "Invented valid private note" },
      ]);
      await invalidating;
      expect(await feedback.list(owner.token)).toBeNull();
    } finally {
      await tableBlocker.query("ROLLBACK");
      await Promise.allSettled([
        ...(reading ? [reading] : []),
        ...(invalidating ? [invalidating] : []),
      ]);
      tableBlocker.release();
      reader.release();
      invalidator.release();
    }
  },
);

it("does not render a private or empty success after read failure and releases authorization locks", async () => {
  const owner = await member("explorer");
  expect(
    await feedback.save(
      owner.token,
      "WF-001",
      1,
      "Invented failed read note",
      0,
    ),
  ).toBe(true);
  const client = await pool.connect();
  const controlled = workflowFeedbackStore({
    connect: async () => ({
      async query(sql: string, values?: unknown[]) {
        const result = await client.query(sql, values);
        if (sql.includes("FROM workflow_feedback"))
          throw new Error("Invented failed read note");
        return result;
      },
      release() {},
    }),
  } as unknown as import("pg").Pool);
  try {
    const result = await feedbackPage(owner.token, controlled);
    expect(result.status).toBe(403);
    expect(result.text).not.toMatch(
      /Invented failed read note|textarea|workflow_version/,
    );
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL lock_timeout='1s'");
      await probe.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        owner.id,
      ]);
      await probe.query(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
        [owner.id],
      );
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
    }
    expect(await feedback.list(owner.token)).toMatchObject([
      { note: "Invented failed read note" },
    ]);
  } finally {
    client.release();
  }
});
