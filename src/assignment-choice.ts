import type { ContentVersion } from "./catalog.ts";
import type { Experience } from "./content.ts";
import type { Exercise, Learner, LessonActivity } from "./store.ts";
import { prerequisitesMet } from "./prerequisites.ts";

const experienceLevel: Record<Experience, number> = {
  new: 0,
  some: 1,
  experienced: 2,
};
const specificity = (item: ContentVersion) =>
  [item.goals, item.backgrounds, item.domains].reduce(
    (score, tags) => score + (tags.length ? 10 - tags.length : 0),
    0,
  );

function eligibleContent(
  items: ContentVersion[],
  learner: Learner,
  progress: Exercise | undefined,
  activity: LessonActivity[],
  kind: "assignment" | "lesson",
): ContentVersion[] {
  return items.filter((item) => {
    if (item.kind !== kind || item.state !== "published") return false;
    if (item.goals.length && !item.goals.includes(learner.goal)) return false;
    if (
      item.backgrounds.length &&
      !item.backgrounds.some(
        (background) =>
          background === learner.background ||
          (learner.backgroundTags ?? []).includes(
            background as Learner["background"],
          ),
      )
    )
      return false;
    if (
      item.domains.length &&
      !item.domains.some((domain) =>
        (learner.domainTags ?? []).includes(
          domain as NonNullable<Learner["domainTags"]>[number],
        ),
      )
    )
      return false;
    if (
      experienceLevel[learner.experience ?? "new"] <
      experienceLevel[item.minimumExperience ?? "new"]
    )
      return false;
    return prerequisitesMet(item, items, progress, activity);
  });
}

export function eligibleAssignments(
  items: ContentVersion[],
  learner: Learner,
  progress: Exercise | undefined,
  activity: LessonActivity[] = [],
): ContentVersion[] {
  return eligibleContent(items, learner, progress, activity, "assignment");
}

export function recommendLesson(
  items: ContentVersion[],
  learner: Learner,
  progress: Exercise | undefined,
  activity: LessonActivity[] = [],
): ContentVersion | null {
  const unfinished = eligibleContent(
    items,
    learner,
    progress,
    activity,
    "lesson",
  ).filter(
    (item) =>
      !activity.some(
        (entry) =>
          entry.contentId === item.id &&
          entry.contentVersion === item.version &&
          entry.selfAssessedAt !== null,
      ),
  );
  return (
    unfinished.find((item) =>
      activity.some(
        (entry) =>
          entry.contentId === item.id &&
          entry.contentVersion === item.version &&
          entry.startedAt !== null,
      ),
    ) ??
    unfinished.sort((a, b) => specificity(b) - specificity(a))[0] ??
    unfinished[0] ??
    null
  );
}
