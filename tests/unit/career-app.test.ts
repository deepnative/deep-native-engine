import { it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { disabledCareerStore, type CareerStore } from "../../src/career.ts";
import type { Store } from "../../src/store.ts";

const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const id = "a4ff1471-0226-4d5b-8677-99c0a94cdf40";
const entry = {
  kind: "career",
  title: "Sample direction",
  note: "Invented only",
  next_action: "Compare sample paths",
  self_reported_outcome: "I may explore this",
  sample_only: "yes",
};
const draft = {
  kind: "proposal",
  title: "Sample proposal",
  body: "An invented proposal with enough useful detail to review.",
  sample_only: "yes",
};

it("requires current member, deliberate opt-in, valid private content and versioned draft approval", async () => {
  let active = false;
  const member = {
    id: "member",
    background: "explorer" as const,
    goal: "everyday" as const,
  };
  const db = {
    session: vi
      .fn<Store["session"]>()
      .mockImplementation(async () =>
        active ? { kind: "active", learner: member } : { kind: "new" },
      ),
  } as unknown as Store;
  const career = {
    ...disabledCareerStore(),
    snapshot: vi
      .fn<CareerStore["snapshot"]>()
      .mockResolvedValue({ enabled: false, entries: [], drafts: [] }),
    enable: vi.fn<CareerStore["enable"]>().mockResolvedValue(false),
    disable: vi.fn<CareerStore["disable"]>().mockResolvedValue(false),
    createEntry: vi.fn<CareerStore["createEntry"]>().mockResolvedValue(false),
    updateEntry: vi.fn<CareerStore["updateEntry"]>().mockResolvedValue(false),
    deleteEntry: vi.fn<CareerStore["deleteEntry"]>().mockResolvedValue(false),
    createDraft: vi.fn<CareerStore["createDraft"]>().mockResolvedValue(false),
    updateDraft: vi.fn<CareerStore["updateDraft"]>().mockResolvedValue(false),
    approveDraft: vi.fn<CareerStore["approveDraft"]>().mockResolvedValue(false),
    revokeDraft: vi.fn<CareerStore["revokeDraft"]>().mockResolvedValue(false),
    deleteDraft: vi.fn<CareerStore["deleteDraft"]>().mockResolvedValue(false),
  };
  const agent = request.agent(app(db, { origin, secret: "secret", career }));
  const welcome = await agent.get("/").set("Host", host).expect(200);
  const csrf = welcome.text.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
  await agent.get("/career").set("Host", host).expect(303);
  active = true;
  const post = (path: string, fields: Record<string, string>) =>
    agent
      .post(path)
      .set("Host", host)
      .set("Origin", origin)
      .type("form")
      .send({ csrf, ...fields });
  const goodEntry = { ...entry };
  const goodDraft = { ...draft };
  expect(
    (await agent.get("/career").set("Host", host).expect(200)).text,
  ).toContain("records are off");
  await post("/career/enable", {}).expect(409);
  await post("/career/enable", { confirm: "yes" }).expect(409);
  career.enable.mockResolvedValue(true);
  await post("/career/enable", { confirm: "yes" }).expect(303);
  career.snapshot.mockResolvedValue({ enabled: true, entries: [], drafts: [] });
  expect(
    (await agent.get("/career").set("Host", host).expect(200)).text,
  ).toContain("No private professional drafts yet");
  await post("/career/entries", {}).expect(422);
  await post("/career/entries", goodEntry).expect(409);
  career.createEntry.mockResolvedValue(true);
  await post("/career/entries", goodEntry).expect(303);
  await post("/career/entries/not-a-uuid/update", {
    ...goodEntry,
    version: "1",
  }).expect(409);
  await post(`/career/entries/${id}/update`, {
    ...goodEntry,
    version: "0",
  }).expect(409);
  await post(`/career/entries/${id}/update`, {
    ...goodEntry,
    version: "1",
    title: "x",
  }).expect(422);
  await post(`/career/entries/${id}/update`, {
    ...goodEntry,
    version: "1",
  }).expect(409);
  career.updateEntry.mockResolvedValue(true);
  await post(`/career/entries/${id}/update`, {
    ...goodEntry,
    version: "1",
  }).expect(303);
  await post(`/career/entries/${id}/delete`, { version: "1" }).expect(409);
  await post(`/career/entries/${id}/delete`, {
    version: "bad",
    confirm: "yes",
  }).expect(409);
  await post(`/career/entries/${id}/delete`, {
    version: "1",
    confirm: "yes",
  }).expect(409);
  career.deleteEntry.mockResolvedValue(true);
  await post(`/career/entries/${id}/delete`, {
    version: "1",
    confirm: "yes",
  }).expect(303);
  await post("/career/drafts", {}).expect(422);
  await post("/career/drafts", goodDraft).expect(409);
  career.createDraft.mockResolvedValue(true);
  await post("/career/drafts", goodDraft).expect(303);
  await post("/career/drafts/no/update", { ...goodDraft, version: "1" }).expect(
    409,
  );
  await post(`/career/drafts/${id}/update`, {
    ...goodDraft,
    version: "1",
    body: "short",
  }).expect(422);
  await post(`/career/drafts/${id}/update`, {
    ...goodDraft,
    version: "1",
  }).expect(409);
  career.updateDraft.mockResolvedValue(true);
  await post(`/career/drafts/${id}/update`, {
    ...goodDraft,
    version: "1",
  }).expect(303);
  await post(`/career/drafts/${id}/approve`, { version: "1" }).expect(409);
  await post(`/career/drafts/${id}/approve`, {
    version: "bad",
    confirm: "yes",
  }).expect(409);
  await post(`/career/drafts/${id}/approve`, {
    version: "1",
    confirm: "yes",
  }).expect(409);
  career.approveDraft.mockResolvedValue(true);
  await post(`/career/drafts/${id}/approve`, {
    version: "1",
    confirm: "yes",
  }).expect(303);
  await post(`/career/drafts/${id}/revoke`, { version: "2" }).expect(409);
  await post(`/career/drafts/${id}/revoke`, {
    version: "2",
    confirm: "yes",
  }).expect(409);
  career.revokeDraft.mockResolvedValue(true);
  await post(`/career/drafts/${id}/revoke`, {
    version: "2",
    confirm: "yes",
  }).expect(303);
  await post(`/career/drafts/${id}/delete`, { version: "3" }).expect(409);
  const deniedDelete = await post(`/career/drafts/${id}/delete`, {
    version: "3",
    confirm: "yes",
  });
  expect(deniedDelete.status, deniedDelete.text).toBe(409);
  career.deleteDraft.mockResolvedValue(true);
  await post(`/career/drafts/${id}/delete`, {
    version: "3",
    confirm: "yes",
  }).expect(303);
  await post("/career/disable", {}).expect(409);
  await post("/career/disable", { confirm: "yes" }).expect(409);
  career.disable.mockResolvedValue(true);
  await post("/career/disable", { confirm: "yes" }).expect(303);
  career.createDraft.mockRejectedValueOnce(new Error("database interrupted"));
  const failed = await post("/career/drafts", goodDraft).expect(503);
  expect(failed.text).toContain("We could not confirm the result");
  await agent
    .post("/career/enable")
    .set("Host", host)
    .set("Origin", "https://other.test")
    .type("form")
    .send({ csrf, confirm: "yes" })
    .expect(403);
  expect(career.createEntry).toHaveBeenCalledWith("member", {
    kind: "career",
    title: entry.title,
    note: entry.note,
    nextAction: entry.next_action,
    selfReportedOutcome: entry.self_reported_outcome,
  });
});
