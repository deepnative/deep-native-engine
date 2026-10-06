import { expect, it } from "vitest";
import {
  eventCancellationScope,
  eventCancellationId,
} from "../../src/event-cancellation-values.ts";
it("EVCANCEL-01/05 accepts only exact canonical references and UUID keys", () => {
  expect(
    eventCancellationScope({ eventId: "local-event", eventVersion: 1 }),
  ).toBe(true);
  expect(eventCancellationId("00000000-0000-4000-8000-000000000001")).toBe(
    true,
  );
  for (const key of [
    undefined,
    null,
    1,
    "",
    " 00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-00000000000A",
    "not-a-key",
  ])
    expect(eventCancellationId(key)).toBe(false);
  for (const scope of [
    undefined,
    null,
    [],
    "local-event",
    {},
    { eventId: "UPPER", eventVersion: 1 },
    { eventId: "a".repeat(81), eventVersion: 1 },
    { eventId: "valid", eventVersion: 0 },
    { eventId: "valid", eventVersion: 1.1 },
    { eventId: "valid", eventVersion: NaN },
    { eventId: "valid", eventVersion: 1000001 },
    { eventId: "valid", eventVersion: "1" },
  ])
    expect(eventCancellationScope(scope as never)).toBe(false);
});
