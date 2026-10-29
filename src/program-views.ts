import { randomUUID } from "node:crypto";
import { escape, page } from "./views.ts";
import {
  PROGRAM_CONFIRM_PATH,
  PROGRAM_PATH,
  type ProgramOverview,
  type ProgramReceipt,
} from "./program-values.ts";

const disclosure = `<p class="eyebrow">Local enrollment simulation</p><p>These six foundation lessons are a prototype, not a full academic term. Enrollment creates no payment, paid entitlement, qualification, calendar commitment or staffed teaching promise. Your common learning access and saved work remain available.</p>`;
const hidden = (name: string, value: string | number) =>
  `<input type="hidden" name="${name}" value="${escape(String(value))}">`;
const confirm = (text: string) =>
  `<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${text}</span></label>`;
export function programOverviewPage(
  item: ProgramOverview,
  csrf: string,
  selecting: boolean,
) {
  const state = item.availability.replaceAll("_", " ");
  return page(
    item.manifest.title,
    `<section class="reading">${disclosure}<h1>${escape(item.manifest.title)}</h1><p>Program version ${item.manifest.programVersion} · local term version ${item.manifest.termVersion}</p><p role="status">Enrollment: ${escape(state)}.</p><p>The simulation admits at most 20 records; this is a local operational bound, not real class or staff capacity.</p><h2>Foundation lesson outcomes</h2><ol>${item.lessons.map((lesson, index) => `<li><strong>${escape(lesson.title)}</strong> · ${escape(lesson.id)} version ${lesson.version}<p>${escape(item.manifest.lessons[index]!.outcome)}</p></li>`).join("")}</ol>${selecting && item.availability === "ready" ? `<form method="post" action="${PROGRAM_PATH}/choose">${hidden("csrf", csrf)}${confirm("Choose this exact local program and term. I will confirm separately after creating or recovering my account.")}<button type="submit">Choose local program</button></form>` : ""}<h2>What comes next</h2><p>Applied workflows, specialization, a supported academic term and monthly projects remain planned. No paid enrollment or service coverage is offered here.</p><p><a href="/learn">Continue common learning</a> · <a href="/my-courses">My courses</a> · <a href="/workflows">Existing workflow demonstrations</a> · <a href="/support">Existing support</a></p><p><a href="${PROGRAM_PATH}">Refresh actual availability</a></p></section>`,
  );
}
export function programConfirmPage(item: ProgramOverview, csrf: string) {
  return page(
    "Confirm local enrollment",
    `<section class="reading">${disclosure}<h1>Confirm local enrollment</h1><p>You are acting on your current learning account. Your prior learning work stays on that account.</p><p>${escape(item.manifest.title)} · program version ${item.manifest.programVersion} · term version ${item.manifest.termVersion}</p><ul>${item.lessons.map((lesson) => `<li>${escape(lesson.id)} · ${escape(lesson.title)} · version ${lesson.version}</li>`).join("")}</ul><form method="post" action="${PROGRAM_PATH}/enroll">${hidden("csrf", csrf)}${hidden("key", randomUUID())}${hidden("programVersion", item.manifest.programVersion)}${hidden("termVersion", item.manifest.termVersion)}${hidden("digest", item.digest)}${hidden("revision", item.revision)}${confirm("Enroll this current account in the local simulation. No charge, teaching service or qualification is created.")}<button type="submit">Confirm local enrollment</button></form><p><a href="${PROGRAM_PATH}">Review program and availability</a> · <a href="/my-courses">Inspect My courses</a></p></section>`,
  );
}
export function programAccountPage(selected: boolean) {
  return page(
    "Return to your learning account",
    `<section class="reading"><h1>Return to your learning account</h1><p>${selected ? "Your selected public program and term can resume in this browser for up to 15 minutes. No enrollment has been created." : "Choose the public program again after recovering your account. No enrollment is inferred."}</p><p><a href="/email/sign-in">Recover existing saved learning</a> or <a href="/">create a new learning account deliberately</a>. Recovery may be unavailable when email is not configured.</p><p>A public selection does not recover an account or move another account's private work.</p><p><a href="${PROGRAM_PATH}">Explore the local program</a></p></section>`,
  );
}
export function programProblemPage(message: string, key?: string) {
  return page(
    "Inspect local enrollment",
    `<section class="reading">${disclosure}<h1>Inspect local enrollment</h1><p role="alert">${escape(message)}</p>${key ? `<p>This response does not confirm whether the enrollment committed. Keep the original key and inspect before choosing another explicit action. Reloading this page does not submit an enrollment.</p><form method="get" action="/my-courses/inspect"><label for="program-original-key">Original enrollment key</label><input id="program-original-key" name="key" value="${escape(key)}" required><button type="submit">Inspect original enrollment</button></form>` : ""}<p><a href="/my-courses">Inspect My courses</a> · <a href="${PROGRAM_PATH}">Refresh program availability</a> · <a href="/email/sign-in">Recover your account</a></p></section>`,
  );
}
export function myCoursesPage(
  receipt: ProgramReceipt | null,
  current: ProgramOverview | null,
) {
  return page(
    "My courses",
    `<section class="reading">${disclosure}<h1>My courses</h1>${
      receipt
        ? `<h2>${escape(receipt.manifest.title)}</h2><p>Local enrollment saved at <time datetime="${receipt.enrolledAt}">${receipt.enrolledAt}</time>. Program version ${receipt.manifest.programVersion}; term version ${receipt.manifest.termVersion}.</p><p>Current enrollment availability: ${escape(current?.availability.replaceAll("_", " ") ?? "temporarily unavailable")}. Your accepted receipt is retained.</p><ol>${receipt.manifest.lessons
            .map((lesson) => {
              const activity = receipt.activity.find(
                (a) => a.id === lesson.id && a.version === lesson.version,
              );
              return `<li><strong>${escape(lesson.id)} version ${lesson.version}</strong><p>${escape(lesson.outcome)}</p><p>${activity?.started ? "Started" : "Not started"} · ${activity?.selfAssessed ? "Self-assessed activity recorded" : "No self-assessed activity recorded"}. This is not mastery or assessed credit.</p>${current && !["course_unavailable"].includes(current.availability) ? `<p><a href="/library/${encodeURIComponent(lesson.id)}?version=${lesson.version}">Open current matching lesson</a></p>` : "<p>Current lesson source is unavailable. Earlier activity is retained without retargeting it.</p>"}</li>`;
            })
            .join(
              "",
            )}</ol><p><a href="/my-courses/${receipt.id}">Inspect your receipt</a> · <a href="/my-courses/${receipt.id}/download">Download private enrollment JSON</a></p>`
        : "<p>No local enrollment is recorded for this account. Choosing a program or signing in does not enroll you.</p>"
    }<p><a href="${PROGRAM_PATH}">Explore local foundation program</a> · <a href="/progress">Existing saved work and activity</a> · <a href="/account">Account and existing exports</a> · <a href="/learn">Continue learning</a></p></section>`,
  );
}
export function programAdminPage(item: ProgramOverview, csrf: string) {
  const action = item.state === "not_open" ? "open" : "close";
  return page(
    "Local program inventory",
    `<section class="reading">${disclosure}<h1>Local program inventory</h1><p>State: ${escape(item.state.replaceAll("_", " "))} · revision ${item.revision}. Current course availability: ${escape(item.availability.replaceAll("_", " "))}.</p><p>Opening requires ordinary editor import, distinct reviewer source/rights approval and editor publication of all six exact reviewed foundation versions. This operation does not publish content or provision teaching staff. Closure is terminal for this prototype.</p>${item.state !== "closed" ? `<form method="post" action="/operator/programs/${action}">${hidden("csrf", csrf)}${hidden("revision", item.revision)}${hidden("digest", item.digest)}${confirm(`${action === "open" ? "Open" : "Close"} this exact local inventory only.`)}<button type="submit">${action === "open" ? "Open" : "Close"} local term</button></form>` : "<p>This local term is closed. No reopening is available.</p>"}<p><a href="/operator/programs">Inspect current state after an uncertain response</a> · <a href="${PROGRAM_PATH}">Public program</a></p></section>`,
  );
}
export const programConfirmationPath = PROGRAM_CONFIRM_PATH;
