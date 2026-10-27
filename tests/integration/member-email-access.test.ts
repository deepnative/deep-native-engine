import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const members = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-email-sign-in-secret";
const delivered: { address: string; link: string }[] = [];
let failDelivery = false;
const access = memberEmailAccess(
  pool,
  {
    async send(address, link) {
      if (failDelivery) throw new Error("Synthetic delivery unavailable");
      delivered.push({ address, link });
    },
  },
  origin,
);
const application = app(members, { origin, secret, memberEmail: access });

beforeAll(() => migrate(pool));
beforeEach(async () => {
  delivered.length = 0;
  failDelivery = false;
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(() => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}
function code() {
  return new URL(delivered.at(-1)!.link).searchParams.get("code")!;
}
function post(path: string, value: Record<string, string>, cookie?: string) {
  const call = request(application)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin);
  if (cookie) call.set("Cookie", `${COOKIE}=${cookie}`);
  return call.type("form").send({ ...value, csrf: csrf(cookie ?? "", secret) });
}
async function anonymousPost(path: string, value: Record<string, string>) {
  const landing = await request(application)
    .get("/email/sign-in")
    .set("Host", "127.0.0.1:3000");
  const cookie = landing.headers["set-cookie"]?.[0]?.match(
    /dne_preview=([a-f0-9]{64})/,
  )?.[1];
  if (!cookie) throw new Error("Sign-in page did not set a browser cookie");
  return post(path, value, cookie);
}

it("EMAIL-ACCESS-01/02 links only the current verified member and reopens the same saved work", async () => {
  const owner = await member();
  await members.save(owner.id, {
    instruction: "Synthetic plan",
    verification: "Synthetic evidence",
    complete: true,
  });
  expect(await members.session(owner.token)).toMatchObject({
    kind: "active",
    learner: { id: owner.id },
  });
  const attach = await post(
    "/email/attach",
    { email: " Member@Example.COM " },
    owner.token,
  );
  expect([attach.status, attach.text.includes("Session expired")]).toEqual([
    200,
    false,
  ]);
  await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 3000 });
  expect(delivered[0]?.address).toBe("member@example.com");
  const attachCode = code();
  const preview = await request(application)
    .get(`/email/confirm?code=${attachCode}`)
    .set("Host", "127.0.0.1:3000");
  expect(preview.status).toBe(200);
  expect(
    await pool.query("SELECT 1 FROM member_email_identities"),
  ).toHaveProperty("rowCount", 0);
  expect(
    (await post("/email/confirm", { code: attachCode }, owner.token)).status,
  ).toBe(200);
  expect(
    (await post("/email/confirm", { code: attachCode }, owner.token)).status,
  ).toBe(409);
  const signin = await anonymousPost("/email/sign-in", {
    email: "MEMBER@example.com",
  });
  expect(signin.status).toBe(200);
  await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 3000 });
  const signedIn = await post("/email/confirm", { code: code() });
  expect(signedIn.status).toBe(303);
  const nextToken = signedIn.headers["set-cookie"]?.[0]?.match(
    /dne_preview=([a-f0-9]{64})/,
  )?.[1];
  expect(nextToken).toBeDefined();
  expect((await members.session(owner.token)).kind).not.toBe("active");
  const resumed = await members.session(nextToken!);
  expect(resumed).toMatchObject({ kind: "active", learner: { id: owner.id } });
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Synthetic plan",
  });
});

it("EMAIL-ACCESS-03/04 does not reveal unknown addresses, reuse links, or merge members", async () => {
  const owner = await member();
  const other = await member();
  await access.requestAttach(owner.token, "member@example.com");
  expect((await access.consume(code())).kind).toBe("attached");
  const unknown = await anonymousPost("/email/sign-in", {
    email: "unknown@example.com",
  });
  const known = await anonymousPost("/email/sign-in", {
    email: "member@example.com",
  });
  expect(unknown.status).toBe(known.status);
  expect(unknown.text).toBe(known.text);
  await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 3000 });
  const stolen = code();
  const otherAttach = await access.requestAttach(
    other.token,
    "member@example.com",
  );
  expect(otherAttach).toBe("unavailable");
  expect((await members.session(other.token)).kind).toBe("active");
  await pool.query(
    "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes' WHERE token_hash=$1",
    [hash(stolen)],
  );
  expect((await access.consume(stolen)).kind).toBe("unavailable");
  expect((await members.session(owner.token)).kind).toBe("active");
  expect(
    (await pool.query("SELECT principal_id FROM member_email_identities"))
      .rows[0]?.principal_id,
  ).toBe(owner.id);
});

it("EMAIL-ACCESS-03 does not switch another active member or consume their link", async () => {
  const owner = await member();
  const other = await member();
  await access.requestAttach(owner.token, "owner@example.com");
  const attachCode = code();
  expect(
    (await post("/email/confirm", { code: attachCode }, other.token)).status,
  ).toBe(409);
  expect(
    (await pool.query("SELECT 1 FROM member_email_identities")).rowCount,
  ).toBe(0);
  expect(
    (await post("/email/confirm", { code: attachCode }, owner.token)).status,
  ).toBe(200);
  await access.requestSignIn("owner@example.com");
  const signInCode = code();

  const foreignSession = await post(
    "/email/confirm",
    { code: signInCode },
    other.token,
  );
  expect(foreignSession.status).toBe(409);
  expect((await members.session(owner.token)).kind).toBe("active");
  expect((await members.session(other.token)).kind).toBe("active");
  expect(
    (
      await pool.query(
        "SELECT consumed_at FROM member_email_links WHERE token_hash=$1",
        [hash(signInCode)],
      )
    ).rows[0]?.consumed_at,
  ).toBeNull();

  const rightfulSession = await post("/email/confirm", { code: signInCode });
  expect(rightfulSession.status).toBe(303);
  expect((await members.session(other.token)).kind).toBe("active");
});

it("EMAIL-ACCESS-03 bounds concurrent requests for one address across different members", async () => {
  const owners = await Promise.all(Array.from({ length: 6 }, () => member()));
  const results = await Promise.all(
    owners.map((owner) =>
      access.requestAttach(owner.token, "shared@example.com"),
    ),
  );
  expect(results.filter((result) => result === "sent")).toHaveLength(5);
  expect(results.filter((result) => result === "unavailable")).toHaveLength(1);
  expect(delivered).toHaveLength(5);
  const verified = await access.consume(code());
  expect(verified.kind).toBe("attached");
  expect(
    (await pool.query("SELECT 1 FROM member_email_identities")).rowCount,
  ).toBe(1);
});

it("EMAIL-ACCESS-04 preserves duplicate-request links and recovers after expiry or failed delivery", async () => {
  const owner = await member();
  await members.save(owner.id, {
    instruction: "Retain my invented work",
    verification: "Compare the invented source",
    complete: true,
  });
  failDelivery = true;
  expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
    "unavailable",
  );
  expect(delivered).toHaveLength(0);
  failDelivery = false;
  expect(await access.requestAttach(owner.token, "member@example.com")).toBe(
    "sent",
  );
  const original = code();
  const duplicates = await Promise.all(
    Array.from({ length: 4 }, () =>
      access.requestAttach(owner.token, "member@example.com"),
    ),
  );
  expect(duplicates).toEqual(Array(4).fill("unavailable"));
  expect(delivered).toHaveLength(1);
  expect(
    (await post("/email/confirm", { code: original }, owner.token)).status,
  ).toBe(200);
  await access.requestSignIn("member@example.com");
  const expired = code();
  await Promise.all(
    Array.from({ length: 4 }, () => access.requestSignIn("member@example.com")),
  );
  expect(delivered).toHaveLength(2);
  await pool.query(
    "UPDATE member_email_links SET created_at=clock_timestamp()-INTERVAL '20 minutes', expires_at=clock_timestamp()-INTERVAL '5 minutes' WHERE token_hash=$1",
    [hash(expired)],
  );
  await access.requestSignIn("member@example.com");
  expect(delivered).toHaveLength(3);
  expect((await access.consume(expired)).kind).toBe("unavailable");
  const returned = await access.consume(code());
  expect(returned.kind).toBe("signed_in");
  expect(await members.session(returned.token!)).toMatchObject({
    kind: "active",
    learner: { id: owner.id },
  });
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Retain my invented work",
  });
});

it("EMAIL-ACCESS-05A shows the current member's linked status after native verification without another attachment form", async () => {
  const owner = await member();
  expect(
    await access.requestAttach(owner.token, "owned-status@example.com"),
  ).toBe("sent");
  expect(await access.consume(code(), owner.token)).toEqual({
    kind: "attached",
  });
  const response = await request(application)
    .get("/email/attach")
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${owner.token}`);
  expect(response.status).toBe(200);
  expect(response.text).toContain("Email already linked");
  expect(response.text).not.toContain('action="/email/attach"');
  expect(response.text).toContain('href="/email/sign-in"');
  expect(response.text).not.toContain("owned-status@example.com");
});

it("EMAIL-ACCESS-05B rechecks an old attachment form after verification without dispatching another message", async () => {
  const owner = await member();
  const before = await request(application)
    .get("/email/attach")
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${owner.token}`);
  expect(before.text).toContain('action="/email/attach"');
  await access.requestAttach(owner.token, "linked-owner@example.com");
  await access.consume(code(), owner.token);
  const dispatch = vi.spyOn(access, "requestAttach");
  try {
    const stale = await post(
      "/email/attach",
      { email: "different@example.com" },
      owner.token,
    );
    expect(stale.status).toBe(200);
    expect(stale.text).toContain("Email already linked");
    expect(stale.text).not.toContain('action="/email/attach"');
    expect(stale.text).not.toContain("different@example.com");
    expect(dispatch).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(
      (await pool.query("SELECT token_hash FROM member_email_links")).rows,
    ).toHaveLength(1);
  } finally {
    dispatch.mockRestore();
  }
});

it("EMAIL-ACCESS-05C keeps another owner's linked address private from an unlinked member", async () => {
  const owner = await member(),
    other = await member();
  await access.requestAttach(owner.token, "private-owner@example.com");
  await access.consume(code(), owner.token);
  expect(await access.ownedStatus(owner.token)).toBe("linked");
  expect(await access.ownedStatus(other.token)).toBe("unlinked");
  const foreign = await post(
    "/email/attach",
    { email: "private-owner@example.com" },
    other.token,
  );
  const unknown = await post(
    "/email/attach",
    { email: "not-linked@example.com" },
    other.token,
  );
  expect(foreign.status).toBe(200);
  expect(foreign.text).toBe(unknown.text);
  expect(foreign.text).not.toContain("private-owner@example.com");
  expect(foreign.text).not.toContain("Email already linked");
  // Await the second dispatch before fixture teardown; the first never changes
  // the existing identity, and a pending unknown-address link is not a binding.
  await vi.waitFor(() => expect(delivered).toHaveLength(2));
  expect(await access.ownedStatus(other.token)).toBe("unlinked");
});

it.each(["expired", "revoked", "deleting"] as const)(
  "EMAIL-ACCESS-05D withholds owned linked state when the member is %s",
  async (state) => {
    const owner = await member();
    await access.requestAttach(owner.token, "private-owner@example.com");
    await access.consume(code(), owner.token);
    if (state === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [owner.id],
      );
    else if (state === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
    else
      await pool.query(
        "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
        [owner.id],
      );
    expect(await access.ownedStatus(owner.token)).toBe("unavailable");
    const get = await request(application)
      .get("/email/attach")
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${owner.token}`);
    const submitted = await post(
      "/email/attach",
      { email: "new@example.com" },
      owner.token,
    );
    expect([303, 503]).toContain(get.status);
    expect([401, 503]).toContain(submitted.status);
    for (const response of [get, submitted]) {
      expect(response.text).not.toContain("Email already linked");
      expect(response.text).not.toContain('action="/email/attach"');
    }
    expect(delivered).toHaveLength(1);
  },
);
