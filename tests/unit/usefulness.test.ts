import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledUsefulnessStore,
  usefulnessStore,
} from "../../src/usefulness.ts";

it("rejects invalid choices and revision tokens before any write", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
  const reports = usefulnessStore({ query } as unknown as Pool);
  for (const [version, revision, choice] of [
    [0, 0, "helpful"],
    [1.5, 0, "helpful"],
    [1, -1, "helpful"],
    [1, 1.5, "helpful"],
    [1, 0, "unsure"],
  ] as const) {
    expect(
      await reports.save(
        "owner",
        "SYN-971",
        version,
        choice as never,
        revision,
      ),
    ).toBe(false);
  }
  expect(await reports.withdraw("owner", "SYN-971", 0, 1)).toBe(false);
  expect(await reports.withdraw("owner", "SYN-971", 1, 0)).toBe(false);
  expect(await reports.withdraw("owner", "SYN-971", 1.5, 1)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

function fixture(
  options: {
    principal?: boolean;
    workspace?: boolean;
    valid?: boolean | "missing";
    changed?: boolean;
    fault?: string;
    rollbackFault?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.rollbackFault)
      throw new Error("rollback fault");
    if (
      options.fault &&
      (options.fault === "COMMIT"
        ? sql === "COMMIT"
        : sql.includes(options.fault))
    )
      throw new Error("synthetic database fault");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "owner-id", expiresAt: new Date() }],
      };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return {
        rows: options.workspace === false ? [] : [{ id: "workspace-id" }],
      };
    if (sql.startsWith("SELECT clock_timestamp"))
      return {
        rows:
          options.valid === "missing"
            ? []
            : [{ valid: options.valid !== false }],
      };
    return { rows: [], rowCount: options.changed === false ? 0 : 1 };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return {
    reports: usefulnessStore({ query, connect } as unknown as Pool),
    query,
    release,
    connect,
  };
}
it("returns accepted and conflict results for creation, correction and withdrawal", async () => {
  for (const changed of [true, false]) {
    const f = fixture({ changed });
    expect(await f.reports.list("unknown")).toEqual([]);
    expect(await f.reports.save("owner", "SYN-971", 1, "helpful", 0)).toBe(
      changed,
    );
    expect(await f.reports.save("owner", "SYN-971", 1, "not_yet", 1)).toBe(
      changed,
    );
    expect(await f.reports.withdraw("owner", "SYN-971", 1, 2)).toBe(changed);
    expect(f.release).toHaveBeenCalledTimes(3);
    expect(f.release).toHaveBeenCalledWith(undefined);
  }
  const disabled = disabledUsefulnessStore();
  expect(await disabled.list("owner")).toEqual([]);
  expect(await disabled.save("owner", "SYN-971", 1, "helpful", 0)).toBeNull();
  expect(await disabled.withdraw("owner", "SYN-971", 1, 1)).toBeNull();
});
it.each([
  { principal: false },
  { workspace: false },
  { valid: false },
  { valid: "missing" as const },
])("rolls back authorization denial safely: %j", async (options) => {
  const f = fixture(options);
  expect(await f.reports.save("owner", "SYN-971", 1, "helpful", 0)).toBeNull();
  expect(f.query).toHaveBeenCalledWith("ROLLBACK");
  expect(f.query).not.toHaveBeenCalledWith("COMMIT");
  expect(f.release).toHaveBeenCalledWith(undefined);
});
it.each([
  "BEGIN",
  "SET LOCAL",
  "SELECT id,expires_at",
  "SELECT id FROM workspaces",
  "INSERT INTO",
  "SELECT clock_timestamp",
  "COMMIT",
])("does not retry failed work at %s", async (fault) => {
  const f = fixture({ fault });
  await expect(
    f.reports.save("owner", "SYN-971", 1, "helpful", 0),
  ).rejects.toThrow("synthetic database fault");
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.query).toHaveBeenCalledWith("ROLLBACK");
  expect(f.release).toHaveBeenCalledWith(
    fault === "COMMIT" ? expect.any(Error) : undefined,
  );
});
it.each([{ principal: false }, { fault: "INSERT INTO" }])(
  "discards connection when rollback fails: %j",
  async (options) => {
    const f = fixture({ ...options, rollbackFault: true });
    await expect(
      f.reports.save("owner", "SYN-971", 1, "helpful", 0),
    ).rejects.toThrow("Usefulness mutation rollback failed");
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  },
);
it("propagates failed acquisition without retrying", async () => {
  const connect = vi.fn().mockRejectedValue(new Error("pool unavailable"));
  const reports = usefulnessStore({ connect } as unknown as Pool);
  await expect(reports.withdraw("owner", "SYN-971", 1, 1)).rejects.toThrow(
    "pool unavailable",
  );
  expect(connect).toHaveBeenCalledTimes(1);
});
