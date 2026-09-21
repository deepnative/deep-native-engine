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
export type Background = keyof typeof BACKGROUNDS;
export type Goal = keyof typeof GOALS;
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
