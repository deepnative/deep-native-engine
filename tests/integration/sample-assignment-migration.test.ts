import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "../../src/sample-feedback-values.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
import { sampleAssignmentFixture } from "../support/sample-assignment.ts";

const pool = testPool();
afterAll(() => pool.end());
it("REVADM-08 upgrades populated migration059 without inventing receipts or rewriting legacy access and repeats safely", async () => {
  const schema = `sample_${randomUUID().replaceAll("-", "")}`;
  const root = await mkdtemp(join(tmpdir(), "dne480-migration-"));
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter(
        (name) =>
          /^\d{3}-[a-z0-9-]+\.sql$/.test(name) &&
          Number(name.slice(0, 3)) <= 59,
      )
      .sort())
      await client.query(await readFile(new URL(name, directory), "utf8"));
    const connection = {
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as Pool;
    const f = await sampleAssignmentFixture(connection, root);
    const assignment = await f.auth.grantAssignment(
      f.administratorId,
      f.reviewerId,
      f.ownerId,
      "reviewer",
      SAMPLE_FEEDBACK_PURPOSE,
      f.end,
    );
    const submission = (
      await client.query(
        "SELECT id FROM evidence_review_submissions WHERE evidence_id=$1",
        [f.input.evidenceId],
      )
    ).rows[0].id;
    const exact = await f.auth.grantEvidenceReview(
      f.administratorId,
      f.reviewerId,
      assignment,
      submission,
      SAMPLE_FEEDBACK_PURPOSE,
      f.end,
    );
    const tables = [
      "evidence_objects",
      "evidence_review_submissions",
      "assignment_grants",
      "reviewer_evidence_grants",
      "authorization_audit",
    ];
    const snapshot = async () => {
      const rows = [];
      for (const table of tables)
        rows.push(
          (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
        );
      return rows;
    };
    const before = await snapshot();
    await migrate(connection);
    await migrate(connection);
    expect(await snapshot()).toEqual(before);
    expect(
      (await client.query("SELECT * FROM private_sample_assignment_operations"))
        .rows,
    ).toEqual([]);
    const history = await f.assignments.history(f.administratorToken, {
      evidenceId: f.input.evidenceId,
      sourceRevision: 1,
    });
    expect(history).toMatchObject({
      kind: "ready",
      history: {
        rows: [
          {
            exactGrantId: exact,
            receiptId: null,
            state: "active",
            canRevoke: true,
          },
        ],
        next: null,
      },
    });
    expect(await f.worklist.list(f.reviewerToken, "active")).toMatchObject({
      kind: "ready",
      items: [{ evidenceId: f.input.evidenceId }],
    });
    const exported = await memberExportStore(connection).exportOwned(
      f.ownerToken,
    );
    expect(exported).toMatchObject({
      kind: "ready",
      payload: {
        version: "local-member-records-v25",
        records: { sampleAssignmentOperations: [] },
      },
    });
    const result = await f.assignments.assign(f.administratorToken, f.input);
    expect(result.kind).toBe("applied");
    await migrate(connection);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM private_sample_assignment_operations",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await client.query("SELECT count(*)::int AS n FROM authorization_audit"))
        .rows[0].n,
    ).toBe(4);
    expect(
      await f.assignments.revoke(
        f.administratorToken,
        { evidenceId: f.input.evidenceId, sourceRevision: 1 },
        exact,
      ),
    ).toMatchObject({
      kind: "revoked",
      row: { exactGrantId: exact, receiptId: null, state: "revoked" },
    });
    expect(await f.worklist.list(f.reviewerToken, "active")).toMatchObject({
      kind: "ready",
      items: [{ evidenceId: f.input.evidenceId }],
    });
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await rm(root, { recursive: true, force: true });
  }
});
