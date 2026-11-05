import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { withDemoSite } from "../../src/hosting-presentation.ts";
import { mountLearningWorkspaceRecords } from "../../src/learning-workspace-records.ts";
import type { LearningWorkspaceStore } from "../../src/learning-workspace-store.ts";
import { learningWorkspacePage } from "../../src/learning-workspace-views.ts";
import { starterGuidanceExample } from "../../src/starter-guidance-views.ts";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";

const banner = '<p class="demo-banner" role="note">';
const stylesheet = '<link rel="stylesheet" href="/assets/demo-banner.css">';

async function records(demoSite: boolean) {
  const store = {
    list: vi.fn().mockResolvedValue({
      kind: "ok",
      value: { items: [], nextCursor: null },
    }),
  } as unknown as LearningWorkspaceStore;
  const app = express();
  app.use((_req, res, next) => {
    res.locals.token = "a".repeat(64);
    withDemoSite(demoSite, next);
  });
  mountLearningWorkspaceRecords(app, store, {
    origin: "http://localhost",
    secret: "synthetic-demo-banner-secret",
  });
  const server = await listenLoopback(app);
  try {
    const response = await request(server).get("/learn/notebooks");
    expect(response.status).toBe(200);
    return response.text;
  } finally {
    await closeLoopback(server);
  }
}

it("DEMOSITE-02 shows the banner and its styles on starter guidance and learning workspace pages", async () => {
  for (const [html, header] of [
    [
      withDemoSite(true, () => starterGuidanceExample("everyday")),
      '<header class="site-header guidance-header">',
    ],
    [
      withDemoSite(true, () => learningWorkspacePage("everyday", "x")),
      '<header class="account-navigation">',
    ],
    [await records(true), '<header class="account-navigation">'],
  ] as const) {
    expect(html).toContain(stylesheet);
    expect(html).toContain(banner);
    expect(html.indexOf(banner)).toBeLessThan(html.indexOf(header));
  }
});

it("DEMOSITE-02 leaves those pages unmarked when the site is not a demo", async () => {
  for (const html of [
    withDemoSite(false, () => starterGuidanceExample("everyday")),
    withDemoSite(false, () => learningWorkspacePage("everyday", "x")),
    await records(false),
  ]) {
    expect(html).not.toContain("demo-banner");
  }
});
