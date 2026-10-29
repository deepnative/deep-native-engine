export const contentVersion = "0.1";
export const labels = ["Supported", "Contradicted", "Not given"];
export const routes = {
  everyday: {
    label: "Everyday",
    topic: "A community activity",
    freshTopic: "A seed swap",
    source:
      "Twelve volunteers are available for two hours on Saturday. The venue and budget are undecided. No start time is given.",
    example:
      "Suggest a community activity plan for twelve volunteers and two hours on Saturday. Use a table with activity, duration and volunteers needed at the same time. Label activities as suggestions. Keep venue, budget and start time undecided. I will check the total duration and simultaneous volunteer counts against these notes.",
    parts: [
      "Twelve volunteers, two hours, Saturday.",
      "An activity plan in a table.",
      "Ideas are suggestions; venue, budget and start time stay open.",
      "Count time and people needed at the same time.",
    ],
    freshSource:
      "A seed-swap table has six helpers and forty seed packets. It opens on Sunday for one hour. The location and start time are undecided.",
    freshRequest:
      "Draft a short invitation to a one-hour seed swap on Sunday, with six helpers and forty packets available. Keep the location and start time to be confirmed. I will check every number and avoid promising a packet to everyone, since attendance is unknown.",
    task: "Ask for a short seed-swap invitation. Include the facts someone needs and make the missing details visible.",
    sample:
      "The seed swap has forty seed packets, eight helpers, and a 10 a.m. start.",
    claims: [
      {
        text: "Forty seed packets are available.",
        answer: "Supported",
        evidence:
          "The source explicitly gives forty seed packets. Keep that number.",
      },
      {
        text: "Eight helpers are available.",
        answer: "Contradicted",
        evidence:
          "The source gives six helpers, not eight. Change the count to six.",
      },
      {
        text: "The seed swap starts at 10 a.m.",
        answer: "Not given",
        evidence:
          "The source leaves the start time undecided. A plausible time is not an agreed time.",
      },
    ],
    repair:
      "Six helpers and forty seed packets are available for a one-hour seed swap on Sunday. The location and start time are to be confirmed.",
    reason:
      "I changed eight helpers to six and removed the assumed start time. The source supplies the count but leaves the time open.",
  },
  work: {
    label: "Work",
    topic: "Meeting actions",
    freshTopic: "A survey trial",
    source:
      "The process test is next Tuesday. Sam writes the checklist. Alex gathers feedback. No announcement owner or date is recorded. No checklist or feedback deadline is given.",
    example:
      "Turn these notes into task, owner and date columns. Keep Sam's checklist and Alex's feedback task. Include the process test next Tuesday with its owner not specified. Mark other missing owners or dates not specified. List announcement ownership and timing as open questions. I will compare every row with the notes.",
    parts: [
      "The test date and each person's stated task.",
      "A task, owner and date table.",
      "Unknown owners and deadlines stay not specified.",
      "Compare each owner and date with its own source statement.",
    ],
    freshSource:
      "Mina drafts a survey. Arun checks the wording. A trial is planned for Thursday. No survey deadline, review deadline or launch date is agreed.",
    freshRequest:
      "Make a task, owner and date table for Mina's survey, Arun's wording check and Thursday's trial. Keep unagreed owners and dates not specified; list the launch date as an open question. I will compare every row with the notes.",
    task: "Ask for an action table. Keep the task-specific owners and dates; do not turn the trial date into every person's deadline.",
    sample:
      "Arun checks the wording. The trial is Friday instead of Thursday. Mina's survey is due Wednesday.",
    claims: [
      {
        text: "Mina's survey is due Wednesday.",
        answer: "Not given",
        evidence:
          "Mina's task is given, but no survey deadline is agreed. Keep its date not specified.",
      },
      {
        text: "Arun checks the wording.",
        answer: "Supported",
        evidence:
          "The source assigns Arun this task. It does not assign every other task to Arun.",
      },
      {
        text: "The trial is Friday instead of Thursday.",
        answer: "Contradicted",
        evidence:
          "The source says Thursday. Friday instead of Thursday conflicts with that date.",
      },
    ],
    repair:
      "Mina drafts the survey and Arun checks the wording. The trial is Thursday. Survey and review deadlines and the launch date are not agreed.",
    reason:
      "I restored Thursday as the trial date and removed the invented Wednesday survey deadline. Task ownership does not establish a deadline.",
  },
  technical: {
    label: "Technical",
    topic: "Sign-up test ideas",
    freshTopic: "A contact form",
    source:
      "A sign-up form accepts email and password. It must explain invalid input without exposing whether an email already has an account. No tests have been run.",
    example:
      "Propose tests for invalid input and account privacy. Use columns for invented input, expected behavior, requirement checked and execution status. Mark every status not run. I will compare coverage with the requirements and run the tests separately.",
    parts: [
      "The form fields and supplied behavior requirements.",
      "Candidate tests with input, expectation, requirement and status.",
      "Invented input; execution stays not run.",
      "Check coverage now and observed results only after execution.",
    ],
    freshSource:
      "A contact form requires an email and message. A blank message must show an explanation. No maximum message length is specified. No tests have been run.",
    freshRequest:
      "Propose cases for the required email and message, including a blank message. List input, expected behavior, source requirement and execution status, using not run. Keep maximum length unspecified. I will check requirement coverage before executing the cases.",
    task: "Ask for test ideas that can be checked against these requirements. Separate expected behavior from observed results.",
    sample:
      "A blank message must show an explanation. All tests have run and passed. Messages are limited to 500 characters.",
    claims: [
      {
        text: "All tests have run and passed.",
        answer: "Contradicted",
        evidence:
          "The source explicitly says no tests have run. A test idea cannot establish a passing result.",
      },
      {
        text: "Messages are limited to 500 characters.",
        answer: "Not given",
        evidence:
          "No maximum length is specified. A familiar-looking limit is still an invented requirement.",
      },
      {
        text: "A blank message must show an explanation.",
        answer: "Supported",
        evidence:
          "This restates the supplied requirement. It does not claim the implementation has been tested.",
      },
    ],
    repair:
      "A blank message is required to show an explanation. Test execution status is not run. The maximum message length is unspecified.",
    reason:
      "I separated the requirement from execution evidence and removed the invented 500-character limit.",
  },
};
