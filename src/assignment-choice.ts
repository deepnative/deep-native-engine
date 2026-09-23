import type { ContentVersion } from "./catalog.ts";
import type { Experience } from "./content.ts";
import type { Exercise, Learner } from "./store.ts";

export const LOCAL_FOUNDATION_PREREQUISITE =
  "LOCAL-FIRST-EXERCISE-COMPLETE" as const;

const experienceLevel: Record<Experience, number> = {
  new: 0,
  some: 1,
  experienced: 2,
};

export function eligibleAssignments(
  items: ContentVersion[],
  learner: Learner,
  progress: Exercise | undefined,
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
    const prerequisite = item.prerequisites.trim();
    return (
      prerequisite === "" ||
      prerequisite.toLowerCase() === "none" ||
      (prerequisite === LOCAL_FOUNDATION_PREREQUISITE &&
        Boolean(progress?.completed_at))
    );
  });
}
