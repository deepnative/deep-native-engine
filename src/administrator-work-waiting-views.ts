import {
  WORKFLOW_REFERENCE_LIMIT,
  type WorkQueue,
  type WorkWaiting,
} from "./administrator-work-waiting.ts";
import { escape } from "./views.ts";

/** Which queues exist on this site. A queue that's off gets no row. */
export interface WorkQueueTools {
  support: boolean;
  feedback: boolean;
  workflow: boolean;
  contributions: boolean;
}
const QUEUES: Array<{
  key: keyof WorkQueueTools;
  label: string;
  href: string;
  role: string;
}> = [
  {
    key: "support",
    label: "Support requests",
    href: "/operator/support-assignment/inbox",
    role: "support operator",
  },
  {
    key: "feedback",
    label: "Feedback requests",
    href: "/operator/sample-assignments/pending",
    role: "reviewer",
  },
  {
    key: "workflow",
    label: "Workflow reviews",
    href: "/operator/workflow-reviews",
    role: "moderator",
  },
  {
    key: "contributions",
    label: "Contributions",
    href: "/moderate/proposals",
    role: "moderator or administrator",
  },
];
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
export function waitedFor(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 1) return "Under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  if (minutes < 2880) return plural(Math.floor(minutes / 60), "hour");
  return plural(Math.floor(minutes / 1440), "day");
}
const assigned = (queue: WorkQueue) =>
  queue.assigned === null
    ? "—"
    : queue.assigned === 0
      ? "0"
      : `${queue.assigned} · oldest ${waitedFor(queue.oldestAssignedMinutes).toLowerCase()}`;
// WAITWORK-09: a count of accounts holding the role, not capacity or availability.
const people = (queue: WorkQueue, role: string) =>
  queue.people
    ? String(queue.people)
    : `0 · No ${escape(role)} is set up on this site`;

const wrapper = (body: string) =>
  `<section class="portal-card" id="work-waiting" aria-labelledby="work-waiting-title"><h2 id="work-waiting-title">Work waiting</h2>${body}</section>`;

export function workWaitingUnavailable() {
  return wrapper(
    '<p role="alert">Waiting work could not be checked just now. This does not mean nothing is waiting. Reload this page to try again.</p>',
  );
}

export function workWaitingCard(value: WorkWaiting, tools: WorkQueueTools) {
  const rows = QUEUES.filter(({ key }) => tools[key]).map(
    ({ key, label, href, role }) => {
      const queue = value[key];
      return `<tr data-work-queue="${key}"><th scope="row"><a href="${href}">${label}</a></th><td>${queue.waiting}</td><td>${waitedFor(queue.oldestWaitingMinutes)}</td><td>${assigned(queue)}</td><td>${people(queue, role)}</td></tr>`;
    },
  );
  if (!rows.length) return "";
  const { references, waiting } = value.workflow;
  const list =
    tools.workflow && references.length
      ? `<details><summary>Workflow review references</summary><p>Assigning a workflow review needs its exact reference. ${waiting > WORKFLOW_REFERENCE_LIMIT ? `Showing the oldest ${WORKFLOW_REFERENCE_LIMIT} of ${waiting}.` : "Oldest first."}</p><ul>${references.map((reference) => `<li><code>${escape(reference)}</code></li>`).join("")}</ul></details>`
      : "";
  return wrapper(
    `<p>Counts and ages only, so no member writing appears here. Ages are facts, not a response-time promise.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Work waiting"><table class="member-table"><thead><tr><th scope="col">Work</th><th scope="col">Waiting</th><th scope="col">Longest wait</th><th scope="col">Assigned, not finished</th><th scope="col">People who can take it</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${list}`,
  );
}
