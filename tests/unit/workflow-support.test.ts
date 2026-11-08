// #769 WFS-01..05: each workflow template says whether it is currently
// supported; overdue, unverified and retired templates never look current.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { app } from "../../src/app.ts";
import type { Store } from "../../src/store.ts";
import {
  retiredWorkflows,
  workflowBundle,
  workflowRegistry,
  workflowSupport,
  workflowTestRoot,
} from "../../src/workflow-registry.ts";
import { withLoopback } from "../support/loopback-server.ts";

const files = {
  "WF-001": "WF-001-requirements.md",
  "WF-002": "WF-002-test-review.md",
  "WF-003": "WF-003-meeting-actions.md",
} as const;
type Id = keyof typeof files;
const real = (id: Id) =>
  readFile(
    new URL(
      `../../assets/docs/content/reviewed-v2/workflows/${files[id]}`,
      import.meta.url,
    ),
    "utf8",
  );
const folders: string[] = [];
// A source release: copy the real templates, then change their metadata.
async function release(changes: Partial<Record<Id, Record<string, string>>>) {
  const folder = await mkdtemp(join(tmpdir(), "dne-workflow-support-"));
  folders.push(folder);
  for (const id of Object.keys(files) as Id[]) {
    let text = (await real(id)).replace(
      /^next_review:.*$/m,
      "next_review: 2999-01-01 or earlier when sources change",
    );
    for (const [key, value] of Object.entries(changes[id] ?? {}))
      text = new RegExp(`^${key}:`, "m").test(text)
        ? text.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`)
        : text.replace(/^version: 2$/m, `version: 2\n${key}: ${value}`);
    await writeFile(join(folder, files[id]), text);
  }
  return pathToFileURL(`${folder}/`);
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true })),
  );
});
const today = "2026-11-08";

it("WFS-01 a template within its review date is currently supported", async () => {
  const root = await release({});
  const item = (await workflowBundle("WF-001", root))!;
  expect(item.nextReviewDate).toBe("2999-01-01");
  expect(workflowSupport(item, today)).toEqual({
    state: "current",
    nextReview: "2999-01-01",
  });
  // The review date itself is still within support; the day after is not.
  expect(workflowSupport(item, "2999-01-01").state).toBe("current");
  expect(workflowSupport(item, "2999-01-02")).toEqual({
    state: "overdue",
    since: "2999-01-01",
  });
});

it("WFS-02/03/05 overdue, unverified or unreadable review dates are not current", async () => {
  const root = await release({
    "WF-001": { next_review: "2026-01-01 manual recheck" },
    "WF-002": { support_state: "unverified" },
    "WF-003": { next_review: "when convenient" },
  });
  expect(
    workflowSupport((await workflowBundle("WF-001", root))!, today),
  ).toEqual({ state: "overdue", since: "2026-01-01" });
  expect(
    workflowSupport((await workflowBundle("WF-002", root))!, today),
  ).toEqual({ state: "unverified" });
  const undated = (await workflowBundle("WF-003", root))!;
  expect(undated.nextReviewDate).toBeNull();
  expect(workflowSupport(undated, today)).toEqual({ state: "undated" });
  // An impossible calendar date is unreadable too.
  const impossible = await release({
    "WF-001": { next_review: "2026-02-30" },
  });
  expect(
    (await workflowBundle("WF-001", impossible))!.nextReviewDate,
  ).toBeNull();
  // An unknown support state is withheld rather than shown as supported.
  const unknown = await release({ "WF-001": { support_state: "maintained" } });
  expect(await workflowBundle("WF-001", unknown)).toBeNull();
  const explicit = await release({ "WF-001": { support_state: "current" } });
  expect(
    workflowSupport((await workflowBundle("WF-001", explicit))!, today).state,
  ).toBe("current");
});

it("WFS-04 a retired template is withheld but its last version stays identified", async () => {
  const root = await release({ "WF-003": { publication_state: "retired" } });
  expect(await workflowBundle("WF-003", root)).toBeNull();
  expect((await workflowRegistry("", root)).map((item) => item.id)).toEqual([
    "WF-001",
    "WF-002",
  ]);
  expect(await retiredWorkflows(root)).toEqual([
    {
      id: "WF-003",
      title: "Extract actions from synthetic meeting notes",
      version: 2,
    },
  ]);
  // Nothing retired in the real release.
  expect(await retiredWorkflows()).toEqual([]);
  // A damaged retired file is not identified with made-up details.
  const damaged = await release({
    "WF-003": { publication_state: "retired", version: "two" },
  });
  expect(await retiredWorkflows(damaged)).toEqual([]);
});

it("WFS-01..05 the list and pages show support status, and retired versions are named but not offered", async () => {
  const root = await release({
    "WF-001": { next_review: "2026-01-01" },
    "WF-002": { support_state: "unverified" },
    "WF-003": { publication_state: "retired" },
  });
  const store = {
    session: vi.fn<Store["session"]>().mockResolvedValue({ kind: "new" }),
  } as unknown as Store;
  await withLoopback(
    app(store, {
      origin: "http://127.0.0.1:3000",
      secret: "secret",
      workflowRoot: root,
    }),
    async (server) => {
      const get = (path: string) =>
        request(server).get(path).set("Host", "127.0.0.1:3000");
      const list = await get("/workflows").expect(200);
      expect(list.text).toContain(
        "Not currently supported: review overdue since 2026-01-01",
      );
      expect(list.text).toContain("Not currently supported: unverified");
      expect(list.text).not.toContain("Currently supported");
      expect(list.text).toContain("Retired versions");
      expect(list.text).toContain(
        "WF-003 · Extract actions from synthetic meeting notes · version 2",
      );
      expect(list.text).not.toContain('href="/workflows/WF-003');
      const overdue = await get("/workflows/WF-001?version=2").expect(200);
      expect(overdue.text).toContain(
        "<dt>Support status</dt><dd>Not currently supported: review overdue since 2026-01-01.",
      );
      const unverified = await get("/workflows/WF-002?version=2").expect(200);
      expect(unverified.text).toContain(
        "<dt>Support status</dt><dd>Not currently supported: unverified.",
      );
      await get("/workflows/WF-003?version=2").expect(404);
      await get("/workflows/WF-003/download?version=2").expect(404);
    },
  );
  const current = await release({});
  await withLoopback(
    app(store, {
      origin: "http://127.0.0.1:3000",
      secret: "secret",
      workflowRoot: current,
    }),
    async (server) => {
      const page = await request(server)
        .get("/workflows/WF-001?version=2")
        .set("Host", "127.0.0.1:3000")
        .expect(200);
      expect(page.text).toContain(
        "<dt>Support status</dt><dd>Currently supported; next review by 2999-01-01.",
      );
      const list = await request(server)
        .get("/workflows")
        .set("Host", "127.0.0.1:3000")
        .expect(200);
      expect(list.text).not.toContain("Retired versions");
    },
  );
});

it("only test mode accepts a fixture template folder", () => {
  expect(workflowTestRoot("test", undefined)).toBeUndefined();
  expect(workflowTestRoot("live", "")).toBeUndefined();
  expect(workflowTestRoot("test", "/tmp/dne-workflows")?.href).toBe(
    "file:///tmp/dne-workflows/",
  );
  expect(workflowTestRoot("test", "/tmp/dne-workflows/")?.href).toBe(
    "file:///tmp/dne-workflows/",
  );
  for (const [mode, value] of [
    ["demo", "/tmp/dne-workflows"],
    ["live", "/tmp/dne-workflows"],
    ["test", "relative/folder"],
  ] as const)
    expect(() => workflowTestRoot(mode, value)).toThrow(
      "DNE_WORKFLOW_ROOT is accepted only in test mode, as an absolute folder.",
    );
});
