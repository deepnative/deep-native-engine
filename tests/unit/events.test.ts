import { expect, it, vi, afterEach } from "vitest";
import { localSlotTime } from "../../src/availability.ts";
import {
  EVENT_PREVIEWS,
  listEventPreviews,
  eventPreviewDetail,
  type EventPreview,
} from "../../src/events.ts";

const now = new Date("2029-01-01T00:00:00.000Z");
const profile = { goal: "everyday" as const, domainTags: [], itRoles: [] };
afterEach(() => vi.useRealTimers());

it("discovers current future previews for each goal without requiring a paid or career identity", () => {
  for (const [goal, id] of [
    ["everyday", "everyday-ai-preview"],
    ["work", "professional-work-preview"],
    ["build", "technical-practice-preview"],
  ] as const) {
    expect(
      listEventPreviews({ ...profile, goal }, { now }).map((event) => event.id),
    ).toEqual(
      id === "everyday-ai-preview"
        ? [id, "local-registration-rehearsal"]
        : ["local-registration-rehearsal", id],
    );
  }
});

it("adds domain and IT interests, deduplicates overlap and lets learners explore other topics", () => {
  expect(
    listEventPreviews(
      { ...profile, domainTags: ["operations"], itRoles: ["qa"] },
      { now },
    ).map((event) => event.id),
  ).toEqual([
    "everyday-ai-preview",
    "local-registration-rehearsal",
    "professional-work-preview",
    "technical-practice-preview",
  ]);
  expect(
    listEventPreviews(
      { ...profile, domainTags: ["creative"], itRoles: ["other"] },
      { now },
    ).map((event) => event.id),
  ).toEqual(["everyday-ai-preview", "local-registration-rehearsal"]);
  expect(listEventPreviews(profile, { now, allTopics: true })).toHaveLength(4);
});

it("uses an exact version and never silently substitutes a replacement", () => {
  expect(eventPreviewDetail("everyday-ai-preview", 1, now).status).toBe(
    "replaced",
  );
  expect(eventPreviewDetail("everyday-ai-preview", 2, now).status).toBe(
    "current",
  );
  expect(eventPreviewDetail("everyday-ai-preview", 3, now)).toEqual({
    status: "missing",
  });
  expect(eventPreviewDetail("missing", 1, now)).toEqual({ status: "missing" });
  expect(eventPreviewDetail("retired-learning-preview", 1, now).status).toBe(
    "retired",
  );
  expect(eventPreviewDetail("past-learning-preview", 1, now).status).toBe(
    "past",
  );
});

it("excludes an event exactly when it starts, remains past after it ends and fails closed for an invalid clock", () => {
  const event = EVENT_PREVIEWS.find(
    (item) => item.id === "everyday-ai-preview" && item.version === 2,
  )!;
  const start = new Date(event.startsAt);
  expect(
    eventPreviewDetail(event.id, event.version, new Date(start.getTime() - 1))
      .status,
  ).toBe("current");
  expect(eventPreviewDetail(event.id, event.version, start).status).toBe(
    "past",
  );
  expect(listEventPreviews(profile, { now: start })).toEqual([]);
  expect(
    listEventPreviews(profile, { now: new Date("2031-01-01T00:00:00.000Z") }),
  ).toEqual([]);
  expect(listEventPreviews(profile, { now: new Date("invalid") })).toEqual([]);
  expect(
    eventPreviewDetail(event.id, event.version, new Date("invalid")),
  ).toEqual({ status: "missing" });
});

it("returns honest empty matches and sorts without modifying the source catalog", () => {
  const event = EVENT_PREVIEWS.find(
    (item) => item.id === "technical-practice-preview",
  )!;
  const catalog: EventPreview[] = [
    { ...event, id: "z-topic" },
    { ...event, id: "a-topic" },
    { ...event, id: "earlier", startsAt: "2030-01-01T00:00:00.000Z" },
  ];
  const original = JSON.stringify(catalog);
  expect(listEventPreviews(profile, { now, catalog })).toEqual([]);
  expect(
    listEventPreviews(profile, { now, catalog, allTopics: true }).map(
      (item) => item.id,
    ),
  ).toEqual(["earlier", "a-topic", "z-topic"]);
  expect(JSON.stringify(catalog)).toBe(original);
  expect(eventPreviewDetail("a-topic", 1, now, catalog).status).toBe("current");
});

it("uses the runtime clock when callers do not override it and preserves retirement after the sample date", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  expect(listEventPreviews(profile)).toHaveLength(2);
  expect(eventPreviewDetail("everyday-ai-preview", 2).status).toBe("current");
  vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
  expect(listEventPreviews(profile)).toEqual([]);
  expect(eventPreviewDetail("retired-learning-preview", 1).status).toBe(
    "retired",
  );
  expect(eventPreviewDetail("everyday-ai-preview", 1).status).toBe("replaced");
});

it("keeps the two repeated Toronto hours tied to their actual UTC instants", () => {
  const first = eventPreviewDetail("everyday-ai-preview", 2, now);
  const second = eventPreviewDetail("professional-work-preview", 1, now);
  if (first.status === "missing" || second.status === "missing")
    throw new Error("Expected catalog fixtures");
  expect(first.event.startsAt).toBe("2030-11-03T05:30:00.000Z");
  expect(second.event.startsAt).toBe("2030-11-03T06:30:00.000Z");
  expect(
    localSlotTime(new Date(first.event.startsAt), "America/Toronto"),
  ).toContain("GMT-04:00");
  expect(
    localSlotTime(new Date(second.event.startsAt), "America/Toronto"),
  ).toContain("GMT-05:00");
});
