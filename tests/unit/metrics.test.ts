import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { disabledMetricsStore, metricsStore } from "../../src/metrics.ts";
import { hash } from "../../src/store.ts";

it("disables preview metrics unless a real store is configured", async () => {
  expect(await disabledMetricsStore().snapshot("a".repeat(64))).toBeNull();
});

it("returns only defined synthetic aggregates to an authorized operator", async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        asOf: new Date("2026-09-24T00:00:00Z"),
        members: 4,
        activated: 3,
        selfAssessed: 1,
        participated: 2,
        activeCircle: 1,
      },
    ],
  });
  const metrics = metricsStore({ query } as unknown as Pool);
  const snapshot = await metrics.snapshot("a".repeat(64));
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("p.revoked_at IS NULL"),
    [hash("a".repeat(64))],
  );
  expect(snapshot).toMatchObject({
    scope: "synthetic-local-preview",
    counts: {
      members: 4,
      activated: 3,
      selfAssessed: 1,
      participated: 2,
      activeCircle: 1,
    },
  });
  expect(snapshot?.definitions.selfAssessed).toContain("not observed skill");
  query.mockResolvedValue({ rows: [] });
  expect(await metrics.snapshot("b".repeat(64))).toBeNull();
});
