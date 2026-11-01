import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import express from "express";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "../../src/sample-feedback-lifetime.ts";
import {
  publicationStore,
  publicationInstruction,
  publicationRevision,
  DISPLAY_PERMISSION,
  type PublicationReceipt,
  type PublicationSource,
  type PublicationStore,
  type PublicationInstruction,
} from "../../src/proposal-publication.ts";
import {
  mountPublicationRoutes,
  mountPublicationStaffRoutes,
} from "../../src/proposal-publication-routes.ts";
import {
  publicationOwnerPage,
  publicationReceiptPage,
  publicationInspectionPage,
  publicationRecoveryPage,
  contributionPage,
  contributionsPage,
} from "../../src/proposal-publication-views.ts";
import { config } from "../../src/config.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
vi.mock("../../src/sample-feedback-lifetime.ts", async (original) => {
  const module =
    await original<typeof import("../../src/sample-feedback-lifetime.ts")>();
  return { ...module, sampleFeedbackTransaction: vi.fn() };
});
const token = "a".repeat(64),
  ownerId = randomUUID(),
  id = randomUUID(),
  workspaceId = randomUUID(),
  publicationId = randomUUID();
const source: PublicationSource = {
  id,
  memberId: ownerId,
  workspaceId,
  title: "Original <example>",
  body: "First <line>\r\nSecond",
  sources: "Original <rights>",
  origin: "member",
  state: "submitted",
  revision: 1,
  rightsRevision: 1,
};
const accepted: PublicationReceipt = {
  id: publicationId,
  proposalId: id,
  revision: 1,
  state: "accepted",
  acceptedAt: new Date("2026-10-27"),
  operationId: null,
  attribution: null,
  audience: null,
  permissionVersion: null,
  publishedAt: null,
  withdrawnAt: null,
};
const input = (): PublicationInstruction => ({
  operationId: randomUUID(),
  proposalId: id,
  revision: 1,
  attribution: "Original <author>",
  audience: "members" as const,
  permissionVersion: DISPLAY_PERMISSION,
  confirmed: true as const,
});
const published = (instruction = input()): PublicationReceipt => ({
  ...accepted,
  state: "published",
  operationId: instruction.operationId,
  attribution: instruction.attribution,
  audience: "members",
  permissionVersion: DISPLAY_PERMISSION,
  publishedAt: new Date("2026-10-27"),
});
const withdrawn = (r = published()): PublicationReceipt => ({
  ...r,
  state: "withdrawn",
  attribution: null,
  withdrawnAt: new Date("2026-10-28"),
});
function fixture(
  options: {
    enabled?: boolean;
    actor?: boolean;
    staff?: boolean;
    workspace?: boolean;
    ownership?: boolean;
    sources?: PublicationSource[];
    receipts?: Array<PublicationReceipt | null>;
    operation?: {
      proposal_id: string;
      member_id: string;
      revision: number;
    } | null;
    error?: Error;
  } = {},
) {
  let receipts = options.receipts ?? [accepted];
  const query = vi.fn(async (sql: string) => {
    if (options.error) throw options.error;
    if (sql.includes("token_hash=$1"))
      return {
        rows:
          options.actor === false
            ? []
            : [{ id: ownerId, expires: new Date(Date.now() + 60000) }],
      };
    if (sql.includes("SELECT role FROM authorized_staff_profiles"))
      return { rows: options.staff === false ? [] : [{ role: "moderator" }] };
    if (sql.includes("SELECT id FROM workspaces WHERE owner_principal_id=$1"))
      return { rows: options.workspace === false ? [] : [{ id: workspaceId }] };
    if (
      sql.includes(
        "SELECT id FROM member_proposals WHERE id=$1 AND member_id=$2",
      )
    )
      return { rows: options.ownership === false ? [] : [{ id }] };
    if (sql.includes("SELECT member_id FROM member_proposals"))
      return { rows: [{ member_id: ownerId }] };
    if (sql.includes("SELECT id FROM workspaces"))
      return { rows: [{ id: workspaceId }] };
    if (sql.includes("SELECT p.id"))
      return { rows: options.sources ?? [source] };
    if (sql.startsWith("SELECT proposal_id,member_id,revision"))
      return {
        rows:
          options.operation === null
            ? []
            : [
                options.operation ?? {
                  proposal_id: id,
                  member_id: ownerId,
                  revision: 1,
                },
              ],
      };
    if (sql.startsWith("SELECT id,proposal_id FROM proposal_publications"))
      return { rows: [{ id: publicationId, proposal_id: id }] };
    if (sql.includes('accepted_at AS "acceptedAt"')) {
      const row = receipts[0];
      if (receipts.length > 1) receipts = receipts.slice(1);
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
  const tx = {
    query,
    observe: vi.fn().mockResolvedValue(undefined),
    deadline: () => performance.now() + 60000,
  } as unknown as SampleTransaction;
  vi.mocked(sampleFeedbackTransaction).mockImplementation(
    async (_pool, _writing, use) => use(tx),
  );
  return {
    target: publicationStore({} as Pool, {
      enabled: options.enabled !== false,
    }),
    query,
    tx,
  };
}
it("requires a canonical exact publication command and bounded explicit attribution", () => {
  expect(publicationInstruction(input())).not.toBeNull();
  for (const value of [
    null,
    undefined,
    [],
    "text",
    {},
    { ...input(), extra: 1 },
    { ...input(), operationId: "bad" },
    { ...input(), proposalId: "bad" },
    { ...input(), revision: 0 },
    { ...input(), attribution: 4 },
    { ...input(), attribution: " " },
    { ...input(), attribution: "a".repeat(81) },
    { ...input(), attribution: "NUL\0" },
    { ...input(), attribution: "\ud800" },
    { ...input(), audience: "public" },
    { ...input(), permissionVersion: "other" },
    { ...input(), confirmed: false },
  ])
    expect(publicationInstruction(value)).toBeNull();
  for (const value of [NaN, undefined, 0, -1, 1.5, 2147483648])
    expect(publicationRevision(value)).toBe(false);
  expect(publicationRevision(2147483647)).toBe(true);
});
it("defaults ordinary contribution creation off and validates its flag", () => {
  const env = { DNE_DATABASE_URL: "postgresql://localhost/dne_dev" };
  expect(config(env).memberContributions).toBe(false);
  expect(
    config({ ...env, DNE_MEMBER_CONTRIBUTIONS: "enabled" }).memberContributions,
  ).toBe(true);
  expect(() => config({ ...env, DNE_MEMBER_CONTRIBUTIONS: "yes" })).toThrow(
    "DNE_MEMBER_CONTRIBUTIONS",
  );
});
it("does not enter storage for malformed identities, revisions, consent or disabled acceptance", async () => {
  const f = fixture();
  expect(await f.target.owner(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.target.accept(token, "bad", 1, true)).toEqual({
    kind: "invalid",
  });
  expect(await f.target.accept(token, id, 0, true)).toEqual({
    kind: "invalid",
  });
  expect(await f.target.accept(token, id, 1, false)).toEqual({
    kind: "invalid",
  });
  expect(await f.target.publish(token, {})).toEqual({ kind: "invalid" });
  expect(await f.target.inspect(token, "bad")).toEqual({ kind: "invalid" });
  expect(await f.target.withdraw(token, "bad", 1)).toEqual({ kind: "invalid" });
  expect(await f.target.withdraw(token, id, 0)).toEqual({ kind: "invalid" });
  expect(await f.target.detail(token, "bad")).toEqual({ kind: "invalid" });
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.target.owner("bad", id)).toEqual({ kind: "denied" });
  expect(
    await fixture({ enabled: false }).target.accept(token, id, 1, true),
  ).toEqual({ kind: "disabled" });
});
it("authorizes current owner, active workspace and permitted staff before returning source or decisions", async () => {
  expect(await fixture({ actor: false }).target.owner(token, id)).toEqual({
    kind: "denied",
  });
  expect(await fixture({ workspace: false }).target.owner(token, id)).toEqual({
    kind: "denied",
  });
  expect(await fixture({ ownership: false }).target.owner(token, id)).toEqual({
    kind: "denied",
  });
  expect(await fixture({ sources: [] }).target.owner(token, id)).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({
      sources: [{ ...source, memberId: randomUUID() }],
    }).target.owner(token, id),
  ).toEqual({ kind: "denied" });
  expect(
    await fixture({ staff: false }).target.accept(token, id, 1, true),
  ).toEqual({ kind: "denied" });
  expect(
    await fixture({ sources: [] }).target.accept(token, id, 1, true),
  ).toEqual({ kind: "denied" });
  const f = fixture({ receipts: [null] });
  expect(await f.target.owner(token, id)).toMatchObject({
    kind: "ready",
    value: { source, receipt: null },
  });
  expect(f.tx.observe).toHaveBeenCalledTimes(2);
});
it("accepts one exact submitted rights revision and retains an existing decision without duplicate writes", async () => {
  for (const patch of [
    { state: "quarantined" },
    { revision: 2 },
    { rightsRevision: null },
  ])
    expect(
      await fixture({ sources: [{ ...source, ...patch }] }).target.accept(
        token,
        id,
        1,
        true,
      ),
    ).toEqual({ kind: "conflict" });
  const f = fixture({ receipts: [null, accepted] });
  expect(await f.target.accept(token, id, 1, true)).toMatchObject({
    kind: "ready",
    value: accepted,
  });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO proposal_publications"),
    ),
  ).toBe(true);
  const replay = fixture();
  expect(await replay.target.accept(token, id, 1, true)).toMatchObject({
    kind: "ready",
    value: accepted,
  });
  expect(
    replay.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO")),
  ).toBe(false);
});
it("requires fresh publication permission while retaining exact committed and withdrawn operation results", async () => {
  const instruction = input(),
    r = published(instruction);
  expect(
    await fixture({ receipts: [null] }).target.publish(token, instruction),
  ).toEqual({ kind: "conflict" });
  for (const patch of [
    { state: "draft" },
    { revision: 2 },
    { rightsRevision: null },
  ])
    expect(
      await fixture({ sources: [{ ...source, ...patch }] }).target.publish(
        token,
        instruction,
      ),
    ).toEqual({ kind: "conflict" });
  expect(
    await fixture({ receipts: [withdrawn()] }).target.publish(
      token,
      instruction,
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await fixture({ enabled: false }).target.publish(token, instruction),
  ).toEqual({ kind: "denied" });
  const f = fixture({ receipts: [accepted, r] });
  expect(await f.target.publish(token, instruction)).toMatchObject({
    kind: "ready",
    value: r,
  });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.includes("UPDATE proposal_publications SET state='published'"),
    ),
  ).toBe(true);
  expect(
    await fixture({ receipts: [r] }).target.publish(token, {
      ...instruction,
      attribution: "different",
    }),
  ).toEqual({ kind: "conflict" });
  for (const receipt of [r, withdrawn(r)]) {
    const replay = fixture({ enabled: false, receipts: [receipt] });
    expect(await replay.target.publish(token, instruction)).toMatchObject({
      kind: "ready",
      value: receipt,
    });
    expect(
      replay.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE ")),
    ).toBe(false);
  }
});
it("keeps receipt inspection owner-only and withdrawal available when writes pause", async () => {
  expect(
    await fixture({ operation: null }).target.inspect(token, randomUUID()),
  ).toMatchObject({ kind: "ready", value: null });
  expect(
    await fixture({
      operation: { proposal_id: id, member_id: randomUUID(), revision: 1 },
    }).target.inspect(token, randomUUID()),
  ).toEqual({ kind: "denied" });
  expect(await fixture().target.inspect(token, randomUUID())).toMatchObject({
    kind: "ready",
    value: accepted,
  });
  expect(
    await fixture({ receipts: [null] }).target.withdraw(token, id, 1),
  ).toEqual({ kind: "denied" });
  const r = withdrawn();
  const f = fixture({ enabled: false, receipts: [published(), r] });
  expect(await f.target.withdraw(token, id, 1)).toMatchObject({
    kind: "ready",
    value: r,
  });
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("state='withdrawn'")),
  ).toBe(true);
  const repeat = fixture({ receipts: [r] });
  expect(await repeat.target.withdraw(token, id, 1)).toMatchObject({
    kind: "ready",
    value: r,
  });
  expect(
    repeat.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE ")),
  ).toBe(false);
});
it("returns only still-published exact source revisions and fails closed on transaction errors", async () => {
  const r = published();
  expect(await fixture({ receipts: [r] }).target.list(token)).toMatchObject({
    kind: "ready",
    value: [{ receipt: r, source }],
  });
  expect(
    await fixture({ receipts: [r] }).target.detail(token, r.id),
  ).toMatchObject({ kind: "ready", value: { receipt: r, source } });
  for (const patch of [
    { id: randomUUID() },
    { revision: 2 },
    { state: "withdrawn" },
    { rightsRevision: null },
  ]) {
    const f = fixture({ sources: [{ ...source, ...patch }], receipts: [r] });
    expect(await f.target.detail(token, r.id)).toEqual({ kind: "denied" });
  }
  expect(await fixture({ receipts: [null] }).target.list(token)).toMatchObject({
    kind: "ready",
    value: [],
  });
  expect(
    await fixture({ error: new Error("private diagnostics") }).target.owner(
      token,
      id,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(
    await fixture({ error: new SampleFeedbackFailure("denied") }).target.detail(
      token,
      r.id,
    ),
  ).toEqual({ kind: "denied" });
});
it("renders exact private and shared states without converting acceptance into consent", () => {
  for (const origin of ["member", "sample"] as const) {
    const text = publicationOwnerPage(
      "nonce",
      { ...source, origin },
      accepted,
      true,
    );
    expect(text).toContain("Accepted privately");
    expect(text).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(text).toContain("&lt;example&gt;");
    expect(text).toContain("&#13;");
    expect(text).toContain('value=""');
    expect(contributionPage({ ...source, origin }, published())).toContain(
      "&lt;author&gt;",
    );
    expect(
      contributionsPage([
        { source: { ...source, origin }, receipt: published() },
      ]),
    ).toContain("&lt;example&gt;");
  }
  expect(
    publicationOwnerPage(
      "nonce",
      { ...source, title: null, body: null, sources: null },
      null,
      false,
    ),
  ).toContain("source text has been removed");
  expect(publicationOwnerPage("nonce", source, accepted, false)).not.toContain(
    "Share this accepted revision",
  );
  expect(
    publicationOwnerPage(
      "nonce",
      { ...source, state: "quarantined" },
      accepted,
      true,
    ),
  ).not.toContain("Share this accepted revision");
  for (const receipt of [accepted, published(), withdrawn()])
    expect(publicationReceiptPage(receipt)).toContain(
      `data-publication-state="${receipt.state}"`,
    );
  expect(
    publicationOwnerPage("nonce", source, withdrawn(), true),
  ).not.toContain("Withdraw sharing</button>");
  expect(contributionsPage([])).toContain("No contributions");
  expect(publicationInspectionPage("<nonce>")).toContain("&lt;nonce&gt;");
  expect(publicationRecoveryPage("nonce", "<failure>")).toContain(
    "&lt;failure&gt;",
  );
  expect(publicationRecoveryPage("nonce", "Unconfirmed", input())).toContain(
    "Repeat this original publication request",
  );
});
const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers) await closeLoopback(server);
  servers.clear();
});
async function routeFixture(present = true) {
  const r = published(),
    ready = <T>(value: T) => ({
      kind: "ready" as const,
      value,
      deadline: performance.now() + 60000,
    });
  const store: PublicationStore = {
    owner: vi.fn().mockResolvedValue(ready({ source, receipt: accepted })),
    accept: vi.fn().mockResolvedValue(ready(accepted)),
    publish: vi.fn().mockResolvedValue(ready(r)),
    inspect: vi.fn().mockResolvedValue(ready(r)),
    withdraw: vi.fn().mockResolvedValue(ready(withdrawn(r))),
    list: vi.fn().mockResolvedValue(ready([{ source, receipt: r }])),
    detail: vi.fn().mockResolvedValue(ready({ source, receipt: r })),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    res.locals.csrf = "nonce";
    next();
  });
  mountPublicationStaffRoutes(app, present ? store : undefined);
  mountPublicationRoutes(app, present ? store : undefined, true);
  const server = await listenLoopback(app);
  servers.add(server);
  return { store, server };
}
const paths = [
  `/contribute/${id}/publication`,
  `/contribute/${id}/publish`,
  `/contribute/${id}/unshare`,
  "/contribution-requests/inspect",
  "/contributions",
  `/contributions/${publicationId}`,
  `/moderate/proposals/${id}/accept`,
];
const publicationForm = () => ({
  csrf: "nonce",
  operationId: randomUUID(),
  revision: "1",
  attribution: "Author",
  audience: "members",
  permissionVersion: DISPLAY_PERMISSION,
  confirmed: "yes",
});
it("mounts private inspection, explicit actions and bounded member reads with no-store responses", async () => {
  const f = await routeFixture();
  for (const path of [paths[0]!, paths[3]!, paths[4]!, paths[5]!])
    await request(f.server)
      .get(path)
      .expect(200)
      .expect("Cache-Control", "no-store");
  await request(f.server)
    .post(paths[6]!)
    .type("form")
    .send({ csrf: "nonce", revision: "1", confirm: "yes" })
    .expect(200);
  await request(f.server)
    .post(paths[1]!)
    .type("form")
    .send(publicationForm())
    .expect(200);
  await request(f.server)
    .post(paths[2]!)
    .type("form")
    .send({ csrf: "nonce", revision: "1", confirm: "yes" })
    .expect(200);
  await request(f.server)
    .post(paths[3]!)
    .type("form")
    .send({ csrf: "nonce", operationId: randomUUID() })
    .expect(200);
  vi.mocked(f.store.inspect).mockResolvedValue({
    kind: "ready",
    value: null,
    deadline: performance.now() + 60000,
  });
  expect(
    (
      await request(f.server)
        .post(paths[3]!)
        .type("form")
        .send({ csrf: "nonce", operationId: randomUUID() })
    ).text,
  ).toContain("No owned receipt");
});
it("rejects absent services and malformed requests without creating publication", async () => {
  const absent = await routeFixture(false);
  for (const [path, method] of [
    [paths[0], "get"],
    [paths[1], "post"],
    [paths[2], "post"],
    [paths[3], "get"],
    [paths[3], "post"],
    [paths[4], "get"],
    [paths[5], "get"],
    [paths[6], "post"],
  ] as const)
    await request(absent.server)[method](path!).expect(404);
  const f = await routeFixture();
  for (const path of [paths[0]!, paths[3]!, paths[4]!, paths[5]!])
    await request(f.server)
      .get(path + "?extra=1")
      .expect(422);
  for (const path of [paths[1]!, paths[2]!, paths[3]!, paths[6]!]) {
    await request(f.server)
      .post(path + "?extra=1")
      .type("form")
      .send({})
      .expect(422);
    await request(f.server).post(path).type("form").send({}).expect(422);
  }
  for (const patch of [
    { confirmed: "no" },
    { revision: "01" },
    { audience: "public" },
    { attribution: ["a", "b"] },
    { extra: "x" },
  ])
    await request(f.server)
      .post(paths[1]!)
      .type("form")
      .send({ ...publicationForm(), ...patch })
      .expect(422);
  await request(f.server)
    .post(paths[2]!)
    .type("form")
    .send({ csrf: "nonce", revision: "1", confirm: "no" })
    .expect(422);
  expect(f.store.publish).not.toHaveBeenCalled();
});
it("reports denial, conflict, unavailable results and elapsed rendering authority without false success", async () => {
  const f = await routeFixture();
  for (const [kind, status] of [
    ["denied", 403],
    ["conflict", 409],
    ["unavailable", 503],
    ["disabled", 404],
    ["invalid", 422],
  ] as const) {
    vi.mocked(f.store.publish).mockResolvedValue({ kind });
    const result = await request(f.server)
      .post(paths[1]!)
      .type("form")
      .send(publicationForm())
      .expect(status);
    expect(
      result.text.includes("Repeat this original publication request"),
    ).toBe(kind === "unavailable");
  }
  vi.mocked(f.store.owner).mockResolvedValue({
    kind: "ready",
    value: { source, receipt: accepted },
    deadline: NaN,
  });
  await request(f.server).get(paths[0]!).expect(403);
  vi.mocked(f.store.publish).mockResolvedValue({
    kind: "ready",
    value: published(),
    deadline: 0,
  });
  const result = await request(f.server)
    .post(paths[1]!)
    .type("form")
    .send(publicationForm())
    .expect(503);
  expect(result.text).toContain("Repeat this original publication request");
});
