import { readFileSync } from "node:fs";
import type { Domain, Goal, ItRole, LearnerProfile } from "./content.ts";

export interface EventPreview {
  id: string;
  version: number;
  status: "current" | "retired" | "replaced";
  title: string;
  description: string;
  agenda: string[];
  goals: Goal[];
  domainTags: Domain[];
  itRoles: ItRole[];
  startsAt: string;
  endsAt: string;
  fixtureCapacity: number;
}

// Trusted, Git-versioned content. The repository gate checks the complete schema,
// canonical UTC dates and version lifecycle before this artifact can be shipped.
export const EVENT_PREVIEWS: readonly EventPreview[] = JSON.parse(
  readFileSync(
    new URL(
      "../assets/docs/content/events/preview-events.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function listEventPreviews(
  profile: Pick<LearnerProfile, "goal" | "domainTags" | "itRoles">,
  {
    allTopics = false,
    now = new Date(),
    catalog = EVENT_PREVIEWS,
  }: {
    allTopics?: boolean;
    now?: Date;
    catalog?: readonly EventPreview[];
  } = {},
): EventPreview[] {
  return catalog
    .filter(
      (event) =>
        event.status === "current" &&
        new Date(event.startsAt).getTime() > now.getTime() &&
        (allTopics ||
          event.goals.includes(profile.goal) ||
          event.domainTags.some((tag) => profile.domainTags.includes(tag)) ||
          event.itRoles.some((role) => profile.itRoles.includes(role))),
    )
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        left.id.localeCompare(right.id),
    );
}

export type EventPreviewDetail =
  | { status: "current" | "past" | "retired" | "replaced"; event: EventPreview }
  | { status: "missing" };

export function eventPreviewDetail(
  id: string,
  version: number,
  now: Date = new Date(),
  catalog: readonly EventPreview[] = EVENT_PREVIEWS,
): EventPreviewDetail {
  const event = catalog.find(
    (item) => item.id === id && item.version === version,
  );
  if (!event || !Number.isFinite(now.getTime())) return { status: "missing" };
  if (event.status !== "current") return { status: event.status, event };
  return {
    status:
      new Date(event.startsAt).getTime() > now.getTime() ? "current" : "past",
    event,
  };
}
