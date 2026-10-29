import type { Goal } from "./content.ts";

// Original Deep Native teaching examples. Version this aid independently from
// the unchanged starter exercise and its retained learner records.
export const STARTER_GUIDANCE_VERSION = "1";
export type GuidanceStep = "practise" | "transfer";
export interface GuidanceChoice {
  id: string;
  text: string;
  correct: boolean;
  explanation: string;
}
export interface GuidanceQuestion {
  source: string;
  question: string;
  hint: string;
  choices: GuidanceChoice[];
}
export interface StarterGuide {
  outcome: string;
  source: string;
  vague: string;
  improved: string;
  context: string;
  task: string;
  check: string;
  practise: GuidanceQuestion;
  transfer: GuidanceQuestion;
}

export const STARTER_GUIDES: Record<Goal, StarterGuide> = {
  everyday: {
    outcome:
      "Write a useful request without letting missing details turn into invented facts.",
    source:
      "A community group has 12 volunteers and two hours on Saturday. The venue and budget are undecided.",
    vague: "Plan a great community event.",
    improved:
      "Suggest a simple activity for a community group with 12 volunteers and two hours on Saturday. Give me a short plan with roles and a time breakdown. Mark the venue and budget as undecided. Do not invent a start time. I will check that the plan stays within two hours and uses no more than 12 volunteers.",
    context: "The request carries over the actual people and time available.",
    task: "A short plan, roles and a time breakdown give the answer a useful shape.",
    check:
      "Numbers can be checked against the note. Missing venue, budget and start time stay unknown.",
    practise: {
      source:
        "12 volunteers. Two hours on Saturday. Venue and budget undecided.",
      question: "Which sentence uses only facts from the note?",
      hint: "Compare the number, day and duration. The note gives no place or start time.",
      choices: [
        {
          id: "a",
          text: "The group has 12 volunteers and two hours on Saturday.",
          correct: true,
          explanation:
            "All three details appear in the note: 12 volunteers, two hours and Saturday. This sentence adds no new fact.",
        },
        {
          id: "b",
          text: "The group has 15 volunteers for Saturday's activity.",
          correct: false,
          explanation:
            "Saturday is supported, but 15 volunteers is not. The note says 12. A sentence can mix a correct detail with an incorrect one.",
        },
        {
          id: "c",
          text: "The volunteers will meet at the library at 9 a.m.",
          correct: false,
          explanation:
            "The note gives neither a library nor a start time. Both need a decision before they can be used as facts.",
        },
      ],
    },
    transfer: {
      source:
        "A book-swap team has eight helpers and 30 donated books. The event is free and will take place on Sunday afternoon. The location is not confirmed.",
      question: "What should a draft invitation say about the location?",
      hint: "An unknown detail can be stated honestly. It does not need to be filled with a plausible guess.",
      choices: [
        {
          id: "a",
          text: "Meet at the library.",
          correct: false,
          explanation:
            "A library sounds plausible for a book swap, but this note does not name it. Plausibility is not a source.",
        },
        {
          id: "b",
          text: "Location to be confirmed.",
          correct: true,
          explanation:
            "This preserves the note's uncertainty. The team can replace it with a confirmed location later.",
        },
        {
          id: "c",
          text: "The event is cancelled because there is no location.",
          correct: false,
          explanation:
            "An unconfirmed location does not mean the event is cancelled. That would add a different unsupported claim.",
        },
      ],
    },
  },
  work: {
    outcome:
      "Turn notes into clear actions while keeping owners and dates grounded in the notes.",
    source:
      "An imaginary team will test a new process next Tuesday. Sam will write the checklist. Alex will gather feedback. The notes do not say who will announce results or when.",
    vague: "Make these meeting notes actionable.",
    improved:
      "Turn these notes into a short action table with task, owner and date columns. The process test is next Tuesday; Sam writes the checklist and Alex gathers feedback. Use 'not specified' for missing owners or dates. Do not assign an announcement task or deadline that the notes do not contain. I will compare every owner and date with the source before sharing the table.",
    context:
      "The note's actual commitments are included, with no extra role assigned to a person.",
    task: "Task, owner and date columns make the output easy for the team to use.",
    check:
      "Each owner and date must be traceable to the note. Missing commitments stay visible.",
    practise: {
      source:
        "Process test next Tuesday. Sam writes the checklist. Alex gathers feedback. No announcement owner or date is recorded.",
      question:
        "Which line adds a commitment that must be checked before using it?",
      hint: "Look for a new job or deadline, not just a person's name that appears in the note.",
      choices: [
        {
          id: "a",
          text: "Sam will write the checklist.",
          correct: false,
          explanation:
            "The note explicitly gives Sam this task. This line does not add a new commitment.",
        },
        {
          id: "b",
          text: "Alex will announce the results on Friday.",
          correct: true,
          explanation:
            "Gathering feedback does not assign Alex the announcement. Friday is also absent. Both the owner and date need confirmation.",
        },
        {
          id: "c",
          text: "Alex will gather feedback.",
          correct: false,
          explanation:
            "This is the task assigned to Alex in the note. The unsupported commitment is elsewhere.",
        },
      ],
    },
    transfer: {
      source:
        "A pilot is scheduled for Wednesday. Jo will collect three participant comments. Rene will update the instructions. The date for deciding whether to continue is not set.",
      question: "Which decision row preserves what the team actually agreed?",
      hint: "The pilot date and the later decision date are different facts.",
      choices: [
        {
          id: "a",
          text: "Decide whether to continue — Friday.",
          correct: false,
          explanation:
            "Friday does not appear in the note. A convenient deadline is still a new commitment.",
        },
        {
          id: "b",
          text: "Decide whether to continue — Wednesday, because the pilot is Wednesday.",
          correct: false,
          explanation:
            "Wednesday is the pilot date. The note explicitly leaves the continuation decision date unset.",
        },
        {
          id: "c",
          text: "Decide whether to continue — date not set; confirm with the team.",
          correct: true,
          explanation:
            "This keeps the missing decision visible and identifies the next check without inventing a date.",
        },
      ],
    },
  },
  build: {
    outcome:
      "Ask for useful tests while separating a requirement, a proposed test and an observed result.",
    source:
      "A sample sign-up form asks for email and password. It must explain invalid input without exposing whether an email already has an account. No tests have been run.",
    vague: "Test this sign-up flow and tell me if it is safe.",
    improved:
      "Suggest test cases for a sign-up form that accepts email and password, explains invalid input and does not expose whether an email already has an account. For each case, list the input, expected behavior and the requirement it checks. Mark execution status as 'not run'. I will compare coverage with the requirements and run the tests before reporting results. No code is needed yet.",
    context: "The request states the actual input and privacy requirements.",
    task: "Inputs and expected behavior turn a general suggestion into test cases someone can execute.",
    check:
      "A proposed test is not a passing result. Evidence comes from running or reviewing it.",
    practise: {
      source:
        "The sign-up form must explain invalid input without exposing whether an email already has an account. No tests have been run.",
      question: "Which statement can we make from these requirements alone?",
      hint: "A requirement tells us what should happen. It does not tell us what happened in a test.",
      choices: [
        {
          id: "a",
          text: "The form passed every privacy test in Firefox.",
          correct: false,
          explanation:
            "No test has been run, and Firefox is not mentioned. The requirements cannot establish a test result.",
        },
        {
          id: "b",
          text: "The form definitely leaks existing email addresses.",
          correct: false,
          explanation:
            "A rule against leaking addresses does not prove that a leak exists. That conclusion also needs evidence.",
        },
        {
          id: "c",
          text: "The form should not reveal whether an email already has an account.",
          correct: true,
          explanation:
            "This restates the supplied requirement. Whether the form meets it remains to be tested.",
        },
      ],
    },
    transfer: {
      source:
        "A different upload form should accept PDF files up to 2 MB and explain rejected input. A colleague proposes trying a 3 MB PDF. Nobody has executed the test yet.",
      question: "What belongs in the test's execution-status column?",
      hint: "An expected rejection is the predicted behavior. Execution status describes evidence collected so far.",
      choices: [
        {
          id: "a",
          text: "Not run; expected behavior is rejection with an explanation.",
          correct: true,
          explanation:
            "This separates the requirement-based expectation from the absence of an observed result.",
        },
        {
          id: "b",
          text: "Passed, because 3 MB is above the limit.",
          correct: false,
          explanation:
            "The size tells us what should happen. It does not prove the form actually rejected the file.",
        },
        {
          id: "c",
          text: "Failed, because the proposed file is too large.",
          correct: false,
          explanation:
            "Testing an invalid file is intentional. Failure or success depends on the observed response, and there is no observation yet.",
        },
      ],
    },
  },
};
