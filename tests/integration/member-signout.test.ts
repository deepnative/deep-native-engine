import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { withLoopback } from "../support/loopback-server.ts";

const root = new URL(
  process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({ connectionString: root.toString() });
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({ connectionString: scoped.toString() });
const members = store(pool);
const origin = "http://127.0.0.1:3000",
  secret = "synthetic-signout-integration";
const messages: string[] = [];
const sender = {
  async send(_address: string, link: string) {
    messages.push(link);
  },
};
const access = memberEmailAccess(pool, sender, origin);
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  messages.length = 0;
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});
function code() {
  return new URL(messages.at(-1)!).searchParams.get("code")!;
}
async function linked() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "work" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic fixture unavailable");
  await members.save(token, {
    revision: 0,
    instruction: "Invented member work",
    verification: "Synthetic source check",
    complete: true,
  });
  await access.requestAttach(token, "member@example.com");
  await access.consume(code(), token);
  return { token, id: session.learner.id };
}
function heldCommit() {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let pid = 0;
  const boundary = {
    async connect() {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "COMMIT") {
            reached();
            await gate;
          }
          return client.query(sql, values);
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  return {
    boundary,
    held,
    release: () => release(),
    async blocked() {
      await vi.waitFor(
        async () =>
          expect(
            Number(
              (
                await pool.query(
                  "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
                  [pid],
                )
              ).rows[0].count,
            ),
          ).toBeGreaterThan(0),
        { timeout: 3000, interval: 10 },
      );
    },
  };
}

it.each(["email-first", "signout-first"])(
  "MOUT-05 serializes %s so stale signout cannot kill the emailed session",
  async (order) => {
    const owner = await linked();
    await access.requestSignIn("member@example.com");
    const challenge = code();
    const lock = heldCommit(),
      controlled = memberEmailAccess(lock.boundary, sender, origin);
    const first =
      order === "email-first"
        ? controlled.consume(challenge)
        : controlled.signOut(owner.token);
    await lock.held;
    const second =
      order === "email-first"
        ? access.signOut(owner.token)
        : access.consume(challenge);
    try {
      await lock.blocked();
    } finally {
      lock.release();
    }
    const [a, b] = await Promise.all([first, second]);
    const signedIn = order === "email-first" ? a : b;
    expect(order === "email-first" ? b : a).toBe(
      order === "email-first" ? "unavailable" : "signed_out",
    );
    if (typeof signedIn === "string") throw Error("Missing sign-in result");
    expect(signedIn.kind).toBe("signed_in");
    expect(await members.session(signedIn.token!)).toMatchObject({
      kind: "active",
      learner: { id: owner.id },
    });
    expect((await members.session(owner.token)).kind).not.toBe("active");
    expect(await members.progress(owner.id)).toMatchObject({
      instruction: "Invented member work",
    });
  },
);

it("MOUT-05 deletion owning the principal lock wins without signout restoring the account", async () => {
  const owner = await linked();
  await access.requestSignIn("member@example.com");
  const challenge = code();
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
    owner.id,
  ]);
  await client.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [owner.id],
  );
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  const signout = access.signOut(owner.token);
  try {
    await vi.waitFor(
      async () =>
        expect(
          Number(
            (
              await pool.query(
                "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0].count,
          ),
        ).toBeGreaterThan(0),
      { timeout: 3000, interval: 10 },
    );
    await client.query("DELETE FROM principals WHERE id=$1", [owner.id]);
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  expect(await signout).toBe("unavailable");
  expect(await access.consume(challenge)).toEqual({ kind: "unavailable" });
  expect(
    (await pool.query("SELECT 1 FROM principals WHERE id=$1", [owner.id]))
      .rowCount,
  ).toBe(0);
});

it("MOUT-01/04 a copied member bearer loses HTTP reads and writes while staff cookie survives", async () => {
  const owner = await linked();
  const staffCookie = "dne_staff=" + "c".repeat(64);
  await withLoopback(
    app(members, { origin, secret, memberEmail: access }),
    async (server) => {
      const http = request(server);
      const signedOut = await http
        .post("/account/sign-out")
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${owner.token}; ${staffCookie}`)
        .type("form")
        .send({ csrf: csrf(owner.token, secret) });
      expect(signedOut.status).toBe(200);
      expect(signedOut.headers["set-cookie"]).toEqual([
        expect.stringContaining("dne_preview=;"),
      ]);
      const copied = await http
        .get("/account")
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${owner.token}`);
      expect(copied.status).toBe(303);
      expect(copied.text).not.toContain("Invented member work");
      const write = await http
        .post("/profile")
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${owner.token}`)
        .type("form")
        .send({
          csrf: csrf(owner.token, secret),
          background: "explorer",
          goal: "everyday",
        });
      expect(write.status).toBe(303);
      expect(
        (
          await pool.query("SELECT background FROM learners WHERE id=$1", [
            owner.id,
          ])
        ).rows[0].background,
      ).toBe("professional");
    },
  );
});

it.each(["before-commit", "lost-commit"])(
  "MOUT-06 %s yields no false HTTP confirmation and deliberate email return restores the same account",
  async (failure) => {
    const owner = await linked();
    let mutations = 0;
    const boundary = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql.startsWith("UPDATE principals SET token_hash")) mutations++;
            if (
              failure === "before-commit" &&
              sql.startsWith("UPDATE learners")
            )
              throw Error("Synthetic storage failure");
            const result = await client.query(sql, values);
            if (failure === "lost-commit" && sql === "COMMIT")
              throw Error("Synthetic lost acknowledgement");
            return result;
          },
          release: (error?: Error) => client.release(error),
        };
      },
    } as unknown as Pool;
    await withLoopback(
      app(members, {
        origin,
        secret,
        memberEmail: memberEmailAccess(boundary, sender, origin),
      }),
      async (server) => {
        const result = await request(server)
          .post("/account/sign-out")
          .set("Host", "127.0.0.1:3000")
          .set("Origin", origin)
          .set("Cookie", `${COOKIE}=${owner.token}`)
          .type("form")
          .send({ csrf: csrf(owner.token, secret) });
        expect(result.status).toBe(503);
        expect(result.text).toContain("Sign-out could not be confirmed");
        expect(result.headers["set-cookie"]).toBeUndefined();
      },
    );
    expect(mutations).toBe(1);
    expect((await members.session(owner.token)).kind === "active").toBe(
      failure === "before-commit",
    );
    await access.requestSignIn("member@example.com");
    const restored = await access.consume(code());
    expect(await members.session(restored.token!)).toMatchObject({
      kind: "active",
      learner: { id: owner.id },
    });
    const hashes = (
      await pool.query(
        "SELECT p.token_hash,l.token_hash AS learner_hash FROM principals p JOIN learners l ON l.id=p.id WHERE p.id=$1",
        [owner.id],
      )
    ).rows[0];
    expect(hashes).toEqual({
      token_hash: hash(restored.token!),
      learner_hash: hash(restored.token!),
    });
  },
);

it("MOUT-05 signout owning the principal lock does not prevent subsequent deletion or revive its saved challenge", async () => {
  const owner = await linked();
  await access.requestSignIn("member@example.com");
  const challenge = code();
  const lock = heldCommit();
  const first = memberEmailAccess(lock.boundary, sender, origin).signOut(
    owner.token,
  );
  await lock.held;
  const deletion = members.remove(owner.id);
  try {
    await lock.blocked();
  } finally {
    lock.release();
  }
  expect(await first).toBe("signed_out");
  await deletion;
  expect(await access.consume(challenge)).toEqual({ kind: "unavailable" });
  expect(
    (await pool.query("SELECT 1 FROM principals WHERE id=$1", [owner.id]))
      .rowCount,
  ).toBe(0);
});
