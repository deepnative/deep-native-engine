import { expect, it, vi } from "vitest";
import { eventCatalogReader } from "../../src/event-catalog.ts";
import {
  REHEARSAL_TEMPLATE,
  rehearsalSnapshot,
} from "../../src/event-rehearsal-values.ts";
const id = "local-rehearsal-00000000-0000-4000-8000-000000000001";
function fixture() {
  const snapshot = rehearsalSnapshot({
    templateId: REHEARSAL_TEMPLATE.id,
    templateVersion: 1,
    startsAt: "2026-10-07T15:30:00.000Z",
  })!;
  return {
    eventId: id,
    eventVersion: 1,
    templateId: snapshot.templateId,
    templateVersion: 1,
    templateDigest: snapshot.templateDigest,
    templateSnapshot: structuredClone(REHEARSAL_TEMPLATE),
    title: snapshot.title,
    startsAt: new Date(snapshot.startsAt),
    endsAt: new Date(snapshot.endsAt),
    capacity: snapshot.capacity,
  };
}
it("REHSCHED-02/07 retains exact legacy content without querying scheduling state or letting a consumer rewrite the template", async () => {
  const reader = eventCatalogReader([REHEARSAL_TEMPLATE]);
  const tx = { query: vi.fn() };
  expect(reader.acceptsReference(REHEARSAL_TEMPLATE.id, 1)).toBe(true);
  expect(reader.acceptsReference("unknown", 1)).toBe(false);
  expect(reader.acceptsReference(id, 1)).toBe(true);
  expect(reader.acceptsReference(id, 2)).toBe(false);
  expect(reader.acceptsReference("local-rehearsal-invalid", 1)).toBe(false);
  const event = await reader.find(tx, REHEARSAL_TEMPLATE.id, 1);
  expect(event).toEqual(REHEARSAL_TEMPLATE);
  event!.agenda.push("consumer mutation");
  expect(REHEARSAL_TEMPLATE.agenda).not.toContain("consumer mutation");
  expect(await reader.find(tx, REHEARSAL_TEMPLATE.id, 2)).toBeUndefined();
  expect(tx.query).not.toHaveBeenCalled();
});
it("REHSCHED-02/07 resolves stored immutable dates with the same trusted content and exact query reference", async () => {
  const reader = eventCatalogReader();
  const tx = { query: vi.fn().mockResolvedValue({ rows: [fixture()] }) };
  const event = await reader.find(tx, id, 1);
  expect(event).toEqual({
    ...REHEARSAL_TEMPLATE,
    id,
    startsAt: "2026-10-07T15:30:00.000Z",
    endsAt: "2026-10-07T16:30:00.000Z",
  });
  expect(tx.query).toHaveBeenCalledTimes(1);
  expect(tx.query.mock.calls[0]![1]).toEqual([id, 1]);
  event!.goals.pop();
  expect((await reader.find(tx, id, 1))!.goals).toEqual(
    REHEARSAL_TEMPLATE.goals,
  );
  tx.query.mockResolvedValue({ rows: [] });
  expect(await reader.find(tx, id, 2)).toBeUndefined();
});
it("REHSCHED-04/07 fails closed for a corrupted or mismatched snapshot instead of advertising different content or capacity", async () => {
  const reader = eventCatalogReader();
  const tx = { query: vi.fn() };
  const invalid = [
    { eventId: "other" },
    { eventVersion: 2 },
    { startsAt: "2026-10-07" },
    { startsAt: new Date(NaN) },
    { endsAt: "2026-10-07" },
    { endsAt: new Date(NaN) },
    { templateSnapshot: { ...REHEARSAL_TEMPLATE, title: "Untrusted clinic" } },
    { templateId: "untrusted-template" },
    { templateVersion: 2 },
    { title: "Different title" },
    { endsAt: new Date("2026-10-07T17:30:00.000Z") },
    { capacity: 100 },
    { templateDigest: "0".repeat(64) },
  ];
  for (const change of invalid) {
    tx.query.mockResolvedValue({ rows: [{ ...fixture(), ...change }] });
    await expect(reader.find(tx, id, 1)).rejects.toThrow("catalog unavailable");
  }
});
it("REHSCHED-04/08 bounds future discovery and retains static readers when creation is paused", async () => {
  const reader = eventCatalogReader([REHEARSAL_TEMPLATE]);
  const tx = { query: vi.fn().mockResolvedValue({ rows: [fixture()] }) };
  const events = await reader.list(tx);
  expect(events.map((event) => event.id)).toEqual([REHEARSAL_TEMPLATE.id, id]);
  events[0]!.agenda.push("consumer mutation");
  expect(REHEARSAL_TEMPLATE.agenda).not.toContain("consumer mutation");
  expect(tx.query).toHaveBeenCalledTimes(1);
  expect(tx.query.mock.calls[0]![0]).toContain("LIMIT 21");
  expect(tx.query.mock.calls[0]![0]).toContain("private_event_cancellations");
  tx.query.mockResolvedValue({ rows: Array.from({ length: 21 }, fixture) });
  await expect(reader.list(tx)).rejects.toThrow("catalog unavailable");
  tx.query.mockRejectedValue(Error("invented query failure"));
  await expect(reader.list(tx)).rejects.toThrow("invented query failure");
});
