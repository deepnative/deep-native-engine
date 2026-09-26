import type { ContentVersion } from "./catalog.ts";
import type { Experience } from "./content.ts";
import type { Exercise, Learner, LessonActivity } from "./store.ts";
import { prerequisitesMet } from "./prerequisites.ts";

const experienceLevel: Record<Experience, number> = {
  new: 0,
  some: 1,
  experienced: 2,
};

export function eligibleAssignments(
  items: ContentVersion[],
  learner: Learner,
  progress: Exercise | undefined,
  activity: LessonActivity[] = [],
): ContentVersion[] {
  return items.filter((item) => {
    if (item.kind !== "assignment" || item.state !== "published") return false;
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
