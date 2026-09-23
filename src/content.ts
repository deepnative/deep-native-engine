export const LESSON = {
  id: "clear-instructions",
  version: 1,
  title: "Give AI a clear starting point",
  minutes: 12,
} as const;
export const BACKGROUNDS = {
  explorer: "Exploring AI",
  professional: "Working in another field",
  technical: "Working in IT",
} as const;
export const GOALS = {
  everyday: "Understand AI and try something useful",
  work: "Make everyday work clearer",
  build: "Improve a technical workflow",
} as const;
export const DOMAINS = {
  education: "Education",
  health: "Health and wellbeing",
  finance: "Finance",
  creative: "Creative work",
  public: "Public service",
  operations: "Operations",
} as const;
export const IT_ROLES = {
  software: "Software development",
  qa: "QA and testing",
  data: "Data, analytics and AI",
  cloud: "Cloud, DevOps and platform",
  security: "Cybersecurity",
  architecture: "Architecture",
  analysis: "Business analysis",
  delivery: "Project, program and delivery management",
  product: "Product ownership and management",
  other: "Other IT specialty",
} as const;
export const EXPERIENCE = {
  new: "Just starting",
  some: "Some practice",
  experienced: "Experienced",
} as const;
export type Background = keyof typeof BACKGROUNDS;
export type Goal = keyof typeof GOALS;
export type Domain = keyof typeof DOMAINS;
export type ItRole = keyof typeof IT_ROLES;
export type Experience = keyof typeof EXPERIENCE;
export interface LearnerProfile {
  background: Background;
  goal: Goal;
  backgroundTags: Background[];
  domainTags: Domain[];
  itRoles: ItRole[];
  experience: Experience | null;
  exploratory: boolean;
}
export function exercise(goal: Goal) {
  const examples = {
    everyday: {
      title: "Plan a small community event",
      brief:
        "A neighbourhood group has 12 volunteers and two hours on Saturday. Draft instructions for AI to suggest a simple event plan. Use only these invented details.",
      check:
        "Check that the plan fits two hours and gives each volunteer a realistic role.",
    },
    work: {
      title: "Turn meeting notes into next steps",
      brief:
        "An imaginary team agreed to test a new process next Tuesday. Sam will write the checklist; Alex will gather feedback. Draft instructions for AI to turn these notes into an action list.",
      check:
        "Compare every owner and date with the original notes. Ask it to mark missing details instead of inventing them.",
    },
    build: {
      title: "Review a sign-up flow",
      brief:
        "A sample app asks for an email and password. It must explain invalid input and avoid exposing whether someone already has an account. Draft instructions for AI to propose useful test cases. No code is required.",
      check:
        "Check that tests cover invalid input, privacy and a successful sign-up. Run or review tests before trusting them.",
    },
  };
  return examples[goal];
}
