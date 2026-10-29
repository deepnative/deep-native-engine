// Original invented editorial exercises. The live lesson drafts already contain
// the corrections; these seeded mistakes belong only to the workshop's v1.
export const fixtureVersion = "2026-10-27.1";
const classifications = ["Supported", "Contradicted", "Not given"];
export const cases = {
  budget: {
    title: "Budget classification",
    lesson: "Lesson 3 · L3-E-P3 / L3-E-X",
    source:
      "Twelve volunteers are available for two hours on Saturday. The venue and budget are undecided. No start time is given.",
    freshSource:
      "A reading group has nine people and meets for forty-five minutes on Wednesday. A room has not been chosen.",
    critique:
      "The practice key calls an undecided budget Contradicted. Use Not given: no amount is established. Check the related Room 4 fresh-case key and explanation for the same mistake.",
    focus: "Separate a missing fact from an incompatible fact.",
    question: "The budget is $200.",
    freshQuestion: "The group meets in Room 4.",
    fields: [
      { key: "answer", label: "Answer key", options: classifications },
      { key: "feedback", label: "Answer explanation" },
      { key: "freshAnswer", label: "Fresh-case key", options: classifications },
      { key: "freshFeedback", label: "Fresh-case explanation" },
    ],
    original: {
      answer: "Contradicted",
      feedback:
        "The budget is undecided, so $200 is contradicted. Choose another amount.",
      freshAnswer: "Contradicted",
      freshFeedback:
        "No room has been chosen, so Room 4 is contradicted. Replace it with Room 2.",
    },
    review:
      "Point to the missing amount and room. Keep the supported people, duration and day. Your explanations should not invent replacements.",
  },
  staffing: {
    title: "Simultaneous staffing",
    lesson: "Lesson 2 · L2-E-P / L2-E-X",
    source:
      "Twelve volunteers, two hours on Saturday; venue and budget undecided; no start time given.",
    freshSource:
      "A seed-swap table has six helpers and forty seed packets. It opens on Sunday for one hour. The location and start time are undecided.",
    critique:
      "The practice request checks duration but does not make staffing inspectable. Ask for volunteers needed at the same time, explain why that differs from adding all staffing numbers, and carry the check into a fresh request.",
    focus: "Turn a vague quality check into something the learner can inspect.",
    question:
      "The request asks for activity and duration columns. What useful instruction should be added?",
    fields: [
      { key: "request", label: "Worked request" },
      { key: "choice", label: "Correct choice wording" },
      { key: "feedback", label: "Answer explanation" },
      { key: "freshRequest", label: "Fresh-case worked request" },
    ],
    original: {
      request:
        "Suggest a two-hour plan for twelve volunteers on Saturday. Use activity and duration columns. Keep venue, budget and start time undecided. I will check the total duration.",
      choice: "Keep venue, budget and start time unconfirmed.",
      feedback:
        "C keeps the unknown arrangements open. A invents a venue; B hides uncertainty.",
      freshRequest:
        "Suggest a one-hour seed-swap plan on Sunday with six helpers and forty packets. Keep location and start time unknown. I will check the duration.",
    },
    review:
      "Check duration and simultaneous helper demand separately. Keep all known limits and unknown arrangements. Try the wording as a learner; the workshop does not grade its meaning.",
  },
};
