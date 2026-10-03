import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledMemberSlotHolds,
  memberSlotHolds,
} from "../../src/slot-holds.ts";
import {
  availabilityPage,
  sampleHoldReceiptPage,
  sampleHoldRecoveryPage,
} from "../../src/views.ts";
import { hash } from "../../src/store.ts";
const slot = "22222222-2222-4222-8222-222222222222";
const grant = "33333333-3333-4333-8333-333333333333";
const id = "44444444-4444-4444-8444-444444444444";
const receipt = {
  id,
  slotId: slot,
  domain: "education",
  serviceType: "coaching" as const,
  startsAt: new Date("2027-11-01T13:00:00Z"),
  endsAt: new Date("2027-11-01T14:00:00Z"),
  expiresAt: new Date("2027-10-01T13:10:00Z"),
  state: "held" as const,
  quantity: 60,
};
it("offers only a matching explicit test allowance and keeps receipt state and deadline honest", () => {
  const html = availabilityPage(
    [{ ...receipt, id: slot }],
    "America/Toronto",
    undefined,
    {
      csrf: "csrf",
      requestIds: { [slot]: id },
      snapshot: {
        grants: [{ id: grant, category: "coach_minutes" }],
        receipts: [],
      },
    },
  );
  expect(html).toContain("Reserve sample hold");
  expect(html).toContain(`name="requestId" value="${id}"`);
  expect(html).toContain("at most 10 minutes");
  expect(html).toContain("test-only deadline");
});

it("does not show a request without the right category and shows only escaped owner receipts", () => {
  const slotRow = { ...receipt, id: slot };
  for (const category of ["review_minutes", undefined] as const) {
    const html = availabilityPage([slotRow], "America/Toronto", undefined, {
      csrf: "csrf",
      requestIds: { [slot]: id },
      snapshot: {
        grants: category ? [{ id: grant, category }] : [],
        receipts: [receipt],
      },
    });
    expect(html).not.toContain("Reserve sample hold");
    expect(html).toContain("No allowance is created here");
    expect(html).toContain(`/availability/holds/${id}`);
  }
  const formal = availabilityPage(
    [{ ...slotRow, serviceType: "formal-review" }],
    "UTC",
    undefined,
    {
      csrf: "csrf",
      requestIds: { [slot]: id },
      snapshot: {
        grants: [{ id: grant, category: "review_minutes" }],
        receipts: [],
      },
    },
  );
  expect(formal).toContain("Reserve sample hold");
  const held = sampleHoldReceiptPage(receipt, "America/Toronto");
  expect(held).toContain("SAMPLE HOLD — NOT A BOOKING");
  expect(held).toContain("60 minutes");
  expect(held).toContain(receipt.expiresAt.toISOString());
  expect(held).toContain("Reload this receipt");
  expect(held).not.toContain(grant);
  const expired = sampleHoldReceiptPage(
    { ...receipt, state: "expired", domain: "<script>" },
    "bad/zone",
  );
  expect(expired).toContain("&lt;script&gt;");
  expect(expired).toContain("units stay expired");
  expect(expired).toContain(receipt.startsAt.toISOString());
  expect(sampleHoldReceiptPage(receipt)).toContain("GMT");
  expect(sampleHoldRecoveryPage(id, "Unknown <private>")).toContain(
    "Unknown &lt;private&gt;",
  );
  expect(sampleHoldRecoveryPage(id, "Unknown")).toContain(
    `/availability/holds/${id}`,
  );
  expect(sampleHoldRecoveryPage(null, "Unknown")).not.toContain(
    "Inspect this request's receipt",
  );
});

it("leaves disabled and invalid member requests without any database mutation", async () => {
  const disabled = disabledMemberSlotHolds();
  expect(await disabled.snapshot("token")).toEqual({
    grants: [],
    receipts: [],
  });
  expect(await disabled.get("token", id)).toBeNull();
  await expect(
    disabled.request("token", slot, grant, id),
  ).rejects.toMatchObject({ code: "unavailable" });
  const query = vi.fn();
  const api = memberSlotHolds({ query } as unknown as Pool);
  for (const token of ["", " ", null as never]) {
    expect(await api.snapshot(token)).toEqual({ grants: [], receipts: [] });
    expect(await api.get(token, id)).toBeNull();
    await expect(api.request(token, slot, grant, id)).rejects.toMatchObject({
      code: "invalid_request",
    });
  }
  expect(await api.get("token", "bad")).toBeNull();
  for (const args of [
    ["bad", grant, id],
    [slot, "bad", id],
    [slot, grant, "bad"],
  ])
    await expect(
      api.request("token", args[0]!, args[1]!, args[2]!),
    ).rejects.toMatchObject({ code: "invalid_request" });
  expect(query).not.toHaveBeenCalled();
});

function privateReadClient(
  options: {
    member?: boolean;
    workspace?: boolean;
    current?: boolean;
    receipts?: unknown[];
    initialReceipts?: unknown[];
  } = {},
) {
  let receiptReads = 0,
    observations = 0;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    void values;
    if (sql.startsWith("WITH instant"))
      return {
        rows:
          observations++ > 0 && options.current === false
            ? []
            : [{ valid: true, remainingMs: "60000", observedAt: new Date(0) }],
      };
    if (sql.includes("FOR SHARE OF p"))
      return {
        rows:
          options.member === false
            ? []
            : [{ id: "member", expiresAt: "2027-10-02T00:00:00Z" }],
      };
    if (sql.includes("SELECT id FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (sql.includes("SELECT r.request_id"))
      return {
        rows:
          receiptReads++ === 0
            ? (options.initialReceipts ?? [])
            : (options.receipts ?? [receipt]),
      };
    if (sql.includes("SELECT g.id,g.category"))
      return { rows: [{ id: grant, category: "coach_minutes" }] };
    if (sql.includes("AS valid"))
      return { rows: [{ valid: options.current !== false }] };
    return { rows: [] };
  });
  return { query, release: vi.fn() };
}

it("settles only the signed-in owner's exact receipts before returning current state and grants", async () => {
  const settled = { ...receipt, state: "expired" };
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [receipt, settled] })
    .mockResolvedValue({ rows: [] });
  const client = privateReadClient({
    receipts: [settled],
    initialReceipts: [receipt, settled],
  });
  const connect = vi.fn(async () => client);
  const api = memberSlotHolds({ query, connect } as unknown as Pool);
  expect(await api.snapshot("token")).toEqual({
    grants: [{ id: grant, category: "coach_minutes" }],
    receipts: [settled],
  });
  expect(query).not.toHaveBeenCalled();
  const preparation = client.query.mock.calls.find(([sql]) =>
    sql.includes("SELECT r.request_id"),
  );
  expect(preparation![1]).toEqual([hash("token"), null]);
  expect(client.query).toHaveBeenCalledWith(
    "SELECT settle_member_sample_holds($1,$2)",
    [hash("token"), id],
  );
  const statements = client.query.mock.calls.map(([sql]) => sql);
  expect(
    statements.indexOf("SELECT settle_member_sample_holds($1,$2)"),
  ).toBeLessThan(statements.indexOf("BEGIN"));
  expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  expect(await api.get("token", id)).toEqual(settled);
  const empty = privateReadClient({ receipts: [] });
  connect.mockResolvedValue(empty);
  expect(await api.get("token", id)).toBeNull();
});

it.each(["member", "workspace", "current"] as const)(
  "withholds private receipts and grants when %s authorization fails",
  async (field) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = privateReadClient({ [field]: false });
    const api = memberSlotHolds({
      query,
      connect: async () => client,
    } as unknown as Pool);
    expect(await api.get("token", id)).toBeNull();
    await expect(api.snapshot("token")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  },
);

it.each(["read", "commit", "rollback"] as const)(
  "withholds private results and avoids replay after a %s failure",
  async (stage) => {
    const client = privateReadClient();
    const read = client.query.getMockImplementation()!;
    const failure = new Error("synthetic private database detail");
    let receiptReads = 0;
    client.query.mockImplementation(async (sql) => {
      const fencedRead =
        sql.includes("SELECT r.request_id") && ++receiptReads === 2;
      if (
        (stage === "commit" && sql === "COMMIT") ||
        (stage !== "commit" && fencedRead) ||
        (stage === "rollback" && sql === "ROLLBACK")
      )
        throw failure;
      return read(sql);
    });
    const connect = vi.fn(async () => client);
    const api = memberSlotHolds({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect,
    } as unknown as Pool);
    if (stage === "rollback")
      await expect(api.snapshot("token")).rejects.toMatchObject({
        code: "unavailable",
      });
    else await expect(api.snapshot("token")).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(
      client.query.mock.calls.filter(([sql]) =>
        sql.includes("SELECT r.request_id"),
      ),
    ).toHaveLength(2);
    if (stage === "commit")
      expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain(
        "ROLLBACK",
      );
    else
      expect(client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  },
);

it("passes only token-derived identity and stable request fields and keeps uncertain writes distinct", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id }] });
  const api = memberSlotHolds({ query } as unknown as Pool);
  expect(await api.request("token", slot, grant, id)).toBe(id);
  expect(query).toHaveBeenCalledWith(
    "SELECT member_sample_hold($1,$2,$3,$4) AS id",
    [hash("token"), slot, grant, id],
  );
  for (const [code, expected] of [
    ["DN001", "invalid_request"],
    ["DN002", "unavailable"],
    ["DN003", "insufficient"],
    ["DN004", "already_settled"],
    ["DN005", "idempotency_conflict"],
    ["08006", "uncertain"],
  ]) {
    query.mockRejectedValueOnce(
      Object.assign(new Error("private database detail"), { code }),
    );
    await expect(api.request("token", slot, grant, id)).rejects.toMatchObject({
      code: expected,
    });
  }
  for (const error of [new Error("private detail"), null, "private detail"]) {
    query.mockRejectedValueOnce(error);
    await expect(api.request("token", slot, grant, id)).rejects.toMatchObject({
      code: "uncertain",
    });
  }
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  await expect(api.request("token", slot, grant, id)).rejects.toMatchObject({
    code: "uncertain",
  });
  const disconnected = memberSlotHolds({
    connect: async () => {
      throw new Error("read failed");
    },
  } as unknown as Pool);
  await expect(disconnected.snapshot("token")).rejects.toThrow("read failed");
});

it("labels the receipt UTC fallback when a member removes or has no valid timezone", () => {
  for (const zone of [undefined, "", "not/a-zone"]) {
    const html = sampleHoldReceiptPage(receipt, zone);
    expect(html).toContain("UTC display window (no valid member time zone)");
    expect(html).not.toContain("Member-local window");
    expect(html).toContain(receipt.startsAt.toISOString());
  }
  const local = sampleHoldReceiptPage(receipt, "America/Toronto");
  expect(local).toContain("Member-local window");
  expect(local).not.toContain("no valid member time zone");
});

it("offers explicit withdrawal only on held receipts and keeps a released receipt with its original deadline", () => {
  const held = sampleHoldReceiptPage(receipt, "UTC", "csrf-marker");
  expect(held).toContain('method="post"');
  expect(held).toContain(`/availability/holds/${id}/withdraw`);
  expect(held).toContain('name="csrf" value="csrf-marker"');
  expect(held).toContain("Withdraw sample hold");
  expect(sampleHoldReceiptPage(receipt, "UTC")).not.toContain(
    "Withdraw sample hold",
  );
  for (const state of ["released", "expired"] as const) {
    const html = sampleHoldReceiptPage(
      { ...receipt, state },
      "UTC",
      "csrf-marker",
    );
    expect(html).not.toContain("Withdraw sample hold");
    expect(html).toContain(receipt.expiresAt.toISOString());
    expect(html).toContain("units stay expired");
    expect(html).toContain(`/availability/holds/${id}`);
  }
  expect(
    sampleHoldReceiptPage(
      { ...receipt, state: "released" },
      "UTC",
      "csrf-marker",
    ),
  ).toContain("You withdrew this sample hold");
});

it("uses only the authenticated token and receipt for withdrawal and preserves unknown-write recovery", async () => {
  await expect(
    disabledMemberSlotHolds().withdraw("token", id),
  ).rejects.toMatchObject({ code: "unavailable" });
  const query = vi.fn().mockResolvedValue({ rows: [{ id }] });
  const api = memberSlotHolds({ query } as unknown as Pool);
  for (const token of ["", " ", null as never])
    await expect(api.withdraw(token, id)).rejects.toMatchObject({
      code: "invalid_request",
    });
  await expect(api.withdraw("token", "bad")).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(query).not.toHaveBeenCalled();
  expect(await api.withdraw("token", id)).toBe(id);
  expect(query).toHaveBeenCalledWith(
    "SELECT withdraw_member_sample_hold($1,$2) AS id",
    [hash("token"), id],
  );
  for (const [code, expected] of [
    ["DN001", "invalid_request"],
    ["DN002", "unavailable"],
    ["08006", "uncertain"],
  ]) {
    query.mockRejectedValueOnce(
      Object.assign(new Error("private failure"), { code }),
    );
    await expect(api.withdraw("token", id)).rejects.toMatchObject({
      code: expected,
    });
  }
  for (const error of [new Error("private failure"), null, "private failure"]) {
    query.mockRejectedValueOnce(error);
    await expect(api.withdraw("token", id)).rejects.toMatchObject({
      code: "uncertain",
    });
  }
  query.mockResolvedValueOnce({ rows: [] });
  await expect(api.withdraw("token", id)).rejects.toMatchObject({
    code: "uncertain",
  });
});
