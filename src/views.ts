import {
  BACKGROUNDS,
  GOALS,
  DOMAINS,
  IT_ROLES,
  EXPERIENCE,
  WEEKLY_TIME,
  LESSON,
  exercise,
} from "./content.ts";
import type {
  Learner,
  Exercise,
  AssignmentChoice,
  Milestone,
} from "./store.ts";
import type { MilestoneInput } from "./milestones.ts";
import type {
  CareerSnapshot,
  CareerEntryInput,
  CareerDraftInput,
} from "./career.ts";
import type { AdapterReadiness, ApplicationMode } from "./adapters.ts";
import { COACHING_OFFERS } from "./offers.ts";
import type { ContentVersion } from "./catalog.ts";
import type { ExpertRecord, TrackSnapshot } from "./track-readiness.ts";
import type { Proposal } from "./proposals.ts";
import { learningPlan } from "./learning-plan.ts";
import type { SubmissionError, SubmissionField } from "./validation.ts";
export function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Deep Native Engine</title><link rel="stylesheet" href="/assets/style.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">d/n</span> deep native<span class="brand-light">engine</span></a><span class="preview-tag">LOCAL LEARNING PREVIEW</span></header><main id="main">${body}</main><footer><strong>Learn something. Make something. Share what works.</strong><span>Local preview · Use sample information only. No AI provider, payment or formal assessment is connected. <a href="/readiness">Integration readiness</a>.</span></footer></body></html>`;
}
export function notice(errors: string[]) {
  return errors.length
    ? `<div class="notice" role="alert"><h2>Let's fix that</h2><ul>${errors.map((e) => `<li>${escape(e)}</li>`).join("")}</ul></div>`
    : "";
}
export function hidden(csrf: string) {
  return `<input type="hidden" name="csrf" value="${csrf}">`;
}
function profileFields(learner?: Learner) {
  const select = (
    name: string,
    label: string,
    choices: Record<string, string>,
    selected?: string | null,
    required = false,
  ) =>
    `<label for="${name}">${label}</label><select id="${name}" name="${name}" ${required ? "required" : ""}><option value="">${required ? "Choose one" : "Not specified"}</option>${Object.entries(
      choices,
    )
      .map(
        ([key, value]) =>
          `<option value="${key}" ${selected === key ? "selected" : ""}>${value}</option>`,
      )
      .join("")}</select>`;
  const checks = (
    name: string,
    label: string,
    choices: Record<string, string>,
    selected: readonly string[],
  ) =>
    `<fieldset><legend>${label}</legend><div class="option-grid">${Object.entries(
      choices,
    )
      .map(
        ([key, value]) =>
          `<label class="check"><input type="checkbox" name="${name}" value="${key}" ${selected.includes(key) ? "checked" : ""}><span>${value}</span></label>`,
      )
      .join("")}</div></fieldset>`;
  return `${select("background", "Your starting point", BACKGROUNDS, learner?.background, true)}
    ${select("goal", "What would you like to do?", GOALS, learner?.goal, true)}
    <p class="small">You can add more interests or change your goal later. These choices never determine admission or payment.</p>
    ${checks("background_tags", "Other starting points (optional)", BACKGROUNDS, learner?.backgroundTags ?? [])}
    ${checks("domain_tags", "Domains of interest (optional)", DOMAINS, learner?.domainTags ?? [])}
    ${checks("it_roles", "IT specialties (optional)", IT_ROLES, learner?.itRoles ?? [])}
    ${select("experience", "Experience with AI (optional)", EXPERIENCE, learner?.experience)}
    <label for="timezone">Time zone (optional)</label><input type="text" id="timezone" name="timezone" value="${escape(learner?.timezone ?? "")}" maxlength="64" placeholder="e.g. America/Toronto"><p class="small">Use a location-style time zone. This preview does not schedule appointments.</p>
    ${select("weekly_minutes", "Weekly time available (optional)", WEEKLY_TIME, learner?.weeklyMinutes?.toString())}
    <label class="check"><input type="checkbox" name="exploratory" value="yes" ${learner?.exploratory ? "checked" : ""}><span>Keep an exploratory path open alongside my primary goal.</span></label>`;
}
export function readinessPage(
  mode: ApplicationMode,
  adapters: AdapterReadiness[],
) {
  return page(
    "Integration readiness",
    `<section class="error-page"><p class="eyebrow">${escape(mode.toUpperCase())} ENVIRONMENT</p><h1>Integration readiness</h1><p class="lead">This page reports integration boundaries. Simulated results never mean a message, payment, upload or provider request happened.</p><ul>${adapters
      .map(
        (adapter) =>
          `<li><strong>${escape(adapter.kind)}</strong> · ${escape(adapter.state)}<br><span>${escape(adapter.message)}</span></li>`,
      )
      .join(
        "",
      )}</ul><p><a href="/readiness/offers">Access and coaching planning</a> · <a href="/readiness/tracks">Learning track readiness</a></p><a class="button" href="/">Return to the learning preview</a></section>`,
  );
}
export function trackReadinessPage(snapshot: TrackSnapshot) {
  return page(
    "Learning track readiness",
    `<section class="error-page"><p class="eyebrow">LOCAL PREVIEW · NO SERVICE BOOKINGS</p><h1>Learning track readiness</h1><p class="lead">Foundation lessons await qualified curriculum sign-off. Specialist services also need reviewed content and current, verified expert coverage. These states do not grant coaching, formal review or admission.</p><h2>Shared foundation</h2><ul>${snapshot.foundation.map(({ goal, state }) => `<li><strong>${escape(GOALS[goal])}</strong> · ${escape(state)}</li>`).join("")}</ul><h2>Specialist domains and services</h2><ul>${snapshot.specialties.map(({ domain, serviceType, state }) => `<li><strong>${escape(DOMAINS[domain])} · ${escape(serviceType)}</strong> · ${escape(state)}</li>`).join("")}</ul><p>General learners may use the separate local preview exercise without a specialist fit review. Tailored service cannot be committed from this page.</p><a href="/readiness">Integration readiness</a></section>`,
  );
}
export function expertRegistryPage(records: ExpertRecord[]) {
  return page(
    "Expert coverage registry",
    `<section class="error-page"><p class="eyebrow">OPERATOR VIEW · EVIDENCE PENDING</p><h1>Expert coverage registry</h1><p class="lead">Roster records alone do not prove qualification or availability. Verify evidence, dates, backup and uncommitted capacity before any owner-approved service offer.</p><ul>${records.map((record) => `<li><strong>${escape(DOMAINS[record.domain])} · ${escape(record.serviceType)}</strong> · ${escape(record.staffRole)} · ${record.startsAt.toISOString().slice(0, 10)} to ${record.endsAt.toISOString().slice(0, 10)} · CAD ${(record.loadedCostCents / 100).toFixed(2)} loaded cost · ${record.capacityMinutes - record.committedMinutes} uncommitted minutes · backup ${record.backupStaffId ? "recorded" : "missing"} · ${record.verifiedAt ? "verification recorded" : "verification pending"}${record.retiredAt ? " · retired" : ""}</li>`).join("")}</ul>${records.length ? "" : "<p>No expert commitments are recorded.</p>"}</section>`,
  );
}
export function proposalListPage(items: Proposal[], csrf: string) {
  return page(
    "Your sample proposals",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SAMPLE INFORMATION ONLY</p><h1>Your sample proposals</h1><p class="lead">Draft an original example. A submitted sample stays in a private moderation queue. No contribution license, publication, expert assessment or public sharing is enabled.</p><ul>${items.map((item) => `<li><a href="/contribute/${escape(item.id)}">${escape(item.title ?? "Redacted proposal")}</a> · ${escape(item.state)}</li>`).join("")}</ul>${items.length ? "" : "<p>No sample proposals yet.</p>"}<h2>New private draft</h2><form method="post" action="/contribute">${hidden(csrf)}<label for="proposal-title">Title</label><input id="proposal-title" name="title" maxlength="160" required><label for="proposal-body">Original sample</label><textarea id="proposal-body" name="body" maxlength="4000" required></textarea><label for="proposal-sources">Sources and rights notes</label><textarea id="proposal-sources" name="sources" maxlength="1000" required></textarea><label class="check"><input type="checkbox" name="sample_confirmed" value="yes" required><span>I used only invented or sample information and understand this is private.</span></label><button type="submit">Save private draft</button></form><p><a href="/learn">Return to learning</a></p></section>`,
  );
}
export function proposalPreviewPage(item: Proposal, csrf: string) {
  const canSubmit = item.state === "draft";
  const canWithdraw = ["draft", "submitted", "quarantined"].includes(
    item.state,
  );
  return page(
    "Private proposal",
    `<section class="error-page"><p class="eyebrow">PRIVATE SAMPLE · ${escape(item.state.toUpperCase())}</p><h1>${escape(item.title ?? "Redacted proposal")}</h1><p class="lead">This is not published or licensed for public reuse.</p>${item.body ? `<h2>Sample</h2><p>${escape(item.body)}</p><h2>Sources and rights notes</h2><p>${escape(item.sources!)}</p>` : "<p>The proposal text has been removed.</p>"}${canSubmit ? `<form method="post" action="/contribute/${escape(item.id)}/submit">${hidden(csrf)}<label class="check"><input type="checkbox" name="rights_confirmed" value="yes" required><span>I created this sample or have the rights to submit it for private moderation. No public license is granted.</span></label><button type="submit">Submit to private moderation</button></form>` : ""}${canWithdraw ? `<form method="post" action="/contribute/${escape(item.id)}/withdraw">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Remove the proposal text and stop moderation.</span></label><button type="submit">Withdraw and redact</button></form>` : ""}<p><a href="/contribute">Your sample proposals</a></p></section>`,
  );
}
export function moderationPage(items: Proposal[], csrf: string) {
  return page(
    "Private proposal moderation",
    `<section class="error-page"><p class="eyebrow">MODERATOR ONLY · NO PUBLICATION</p><h1>Private proposal moderation</h1><p class="lead">Review submitted sample text in quarantine. You can quarantine or reject and redact it. Approval and publication are unavailable while licensing policy is pending.</p><ul>${items.map((item) => `<li><strong>${escape(item.title!)}</strong> · ${escape(item.state)}<p>${escape(item.body!)}</p><p>Sources: ${escape(item.sources!)}</p>${item.state === "submitted" ? `<form method="post" action="/moderate/proposals/${escape(item.id)}/quarantine">${hidden(csrf)}<button type="submit">Quarantine for review</button></form>` : ""}<form method="post" action="/moderate/proposals/${escape(item.id)}/reject">${hidden(csrf)}<button type="submit">Reject and redact</button></form></li>`).join("")}</ul>${items.length ? "" : "<p>No submitted proposals await moderation.</p>"}</section>`,
  );
}
export function offerHypothesesPage() {
  return page(
    "Access and coaching planning",
    `<section class="error-page"><p class="eyebrow">PLANNING ONLY · NO LIVE PURCHASE</p><h1>Access and coaching planning</h1><p class="lead">The local foundation preview uses sample information only. Live learning and participation access rules, limits, AI allowance and price are pending owner approval. No live access or credits are granted here.</p><p>Coaching is optional. These historical prices and allowances are hypotheses, not available offers. A professional background never assigns the Professional coaching package or staff access.</p><ul>${COACHING_OFFERS.map((offer) => `<li><strong>${escape(offer.id)}</strong> · CAD ${(offer.priceCents / 100).toLocaleString("en-CA")} · ${offer.months} monthly periods · ${offer.monthly.coachMinutes} coach / ${offer.monthly.reviewMinutes} review / ${offer.monthly.supportMinutes} support minutes per period · ${escape(offer.termsVersion)} · ${escape(offer.state)}</li>`).join("")}</ul><p>Annual prepayment does not issue future monthly credits. The pilot's internal onboarding reserve is not a purchased member allowance. Qualified capacity, approved terms and an explicit access decision are required before any live service.</p><a class="button" href="/readiness">Integration readiness</a></section>`,
  );
}
function assignmentSection(
  items: ContentVersion[],
  choice: AssignmentChoice | null,
  csrf: string,
) {
  const selected = items.find(
    (item) =>
      item.id === choice?.contentId && item.version === choice.contentVersion,
  );
  return `<section class="assignment-options" aria-labelledby="assignment-options-title"><p class="eyebrow">PUBLISHED SAMPLE CONTENT</p><h2 id="assignment-options-title">Choose a practice assignment</h2><p class="small">Suggestions match your current direction and self-reported experience. A completed local exercise can satisfy only the explicitly named local prerequisite; it is not a skill assessment.</p>${selected ? `<p role="status">Your chosen sample: <a href="/library/${encodeURIComponent(selected.id)}">${escape(selected.title)}</a> · version ${selected.version}</p>` : choice ? '<p role="status">Your saved choice is no longer available for this direction or published version. Choose another sample below.</p>' : ""}${items.length ? `<ul>${items.map((item) => `<li><strong>${escape(item.title)}</strong> · version ${item.version} · ${escape(EXPERIENCE[item.minimumExperience ?? "new"])}<p>${escape(item.prerequisites || "No prerequisite")}</p><form method="post" action="/assignments/select">${hidden(csrf)}<input type="hidden" name="content_id" value="${escape(item.id)}"><input type="hidden" name="content_version" value="${item.version}"><button type="submit" class="secondary">Choose ${escape(item.title)}</button> <a href="/library/${encodeURIComponent(item.id)}">Read sample</a></form></li>`).join("")}</ul>` : "<p>No published assignment currently fits your goal, interests, experience and completed prerequisites. Continue with the local foundation lesson or revise your direction.</p>"}</section>`;
}
function milestoneFields(prefix: string, value?: MilestoneInput) {
  return `<label for="${prefix}-goal">Learning or project goal</label><input type="text" id="${prefix}-goal" name="goal_title" maxlength="160" required value="${escape(value?.goalTitle ?? "")}"><label for="${prefix}-milestone">Practical milestone</label><input type="text" id="${prefix}-milestone" name="milestone_title" maxlength="160" required value="${escape(value?.milestoneTitle ?? "")}"><label for="${prefix}-evidence">Evidence note (sample information only)</label><textarea id="${prefix}-evidence" name="evidence_note" maxlength="1000">${escape(value?.evidenceNote ?? "")}</textarea><label for="${prefix}-next">Next action</label><textarea id="${prefix}-next" name="next_action" maxlength="500" required>${escape(value?.nextAction ?? "")}</textarea><div class="milestone-reminder"><label for="${prefix}-date">Local reminder date (optional)</label><input id="${prefix}-date" name="reminder_date" type="date" value="${escape(value?.reminderDate ?? "")}"><label for="${prefix}-time">Local reminder time (optional)</label><input id="${prefix}-time" name="reminder_time" type="time" value="${escape(value?.reminderTime ?? "")}"></div><label class="check"><input type="checkbox" name="complete" value="yes" ${value?.selfReportedComplete ? "checked" : ""}><span>Mark this milestone complete based on my own evidence note (self-reported)</span></label><label class="check"><input type="checkbox" name="sample_only" value="yes" required><span>I used only invented or sample information and understand this stays private in the local preview.</span></label>`;
}
export function milestonesPage(
  member: Learner,
  items: Milestone[],
  csrf: string,
  errors: string[] = [],
  draft?: MilestoneInput,
  editId?: string,
) {
  return page(
    "Your goals and milestones",
    `<section class="error-page milestone-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · NO OUTBOUND REMINDERS</p><h1>Your goals and milestones</h1><p class="lead">Record one practical step at a time. Evidence and completion here are your own notes, not a verified credential or commercial result.</p><p>Local reminder time zone: <strong>${escape(member.timezone ?? "Not set")}</strong>. A date and time only appear here; no email, device notification or appointment is sent. Saving an edited reminder uses your current profile time zone. <a href="/learn">Change your time zone in your learning direction</a>.</p>${notice(errors)}<h2>Saved milestones</h2>${
      items.length
        ? `<ul class="milestone-list">${items
            .map((item) => {
              const value = item.id === editId ? (draft ?? item) : item;
              const url = `/milestones/${encodeURIComponent(item.id)}`;
              return `<li><h3>${escape(item.milestoneTitle)}</h3><p>Goal: ${escape(item.goalTitle)}</p><p>Status: ${item.selfReportedComplete ? "complete · self-reported" : "planned or in progress"}</p><p>Evidence note: ${escape(item.evidenceNote || "None yet")}</p><p>Next action: ${escape(item.nextAction)}</p>${item.reminderDate ? `<p>Local reminder: ${escape(item.reminderDate)} at ${escape(item.reminderTime!)} (${escape(item.reminderTimezone!)}) · shown here only</p>` : ""}<details ${item.id === editId ? "open" : ""}><summary>Edit this milestone</summary><form method="post" action="${url}/update">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}">${milestoneFields(`edit-${item.id}`, value)}<button type="submit">Save changes</button></form></details><form method="post" action="${url}/delete">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete this private milestone and its note</span></label><button class="secondary" type="submit">Delete milestone</button></form></li>`;
            })
            .join("")}</ul>`
        : "<p>No milestones yet. Start with one useful action below.</p>"
    }<h2>Plan a private milestone</h2><form method="post" action="/milestones">${hidden(csrf)}${milestoneFields("new-milestone", editId ? undefined : draft)}<button type="submit">Save private milestone</button></form><p><a href="/learn">Return to learning</a></p></section>`,
  );
}
function careerEntryFields(prefix: string, value?: CareerEntryInput) {
  const kinds = {
    career: "Career goal",
    opportunity: "Opportunity",
    contract: "Contract or renewal",
  };
  return `<label for="${prefix}-kind">Planning kind</label><select id="${prefix}-kind" name="kind" required>${Object.entries(
    kinds,
  )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${value?.kind === key ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select><label for="${prefix}-title">Private title</label><input id="${prefix}-title" name="title" maxlength="160" required value="${escape(value?.title ?? "")}"><label for="${prefix}-note">Private note (sample information only)</label><textarea id="${prefix}-note" name="note" maxlength="1000">${escape(value?.note ?? "")}</textarea><label for="${prefix}-next">Next action</label><textarea id="${prefix}-next" name="next_action" maxlength="500" required>${escape(value?.nextAction ?? "")}</textarea><label for="${prefix}-outcome">Self-reported outcome (optional)</label><textarea id="${prefix}-outcome" name="self_reported_outcome" maxlength="500">${escape(value?.selfReportedOutcome ?? "")}</textarea><label class="check"><input type="checkbox" name="sample_only" value="yes" required><span>I used only invented or sample information.</span></label>`;
}
function careerDraftFields(prefix: string, value?: CareerDraftInput) {
  const kinds = {
    professional: "Professional note",
    proposal: "Proposal",
    renewal: "Renewal",
  };
  return `<label for="${prefix}-kind">Draft kind</label><select id="${prefix}-kind" name="kind" required>${Object.entries(
    kinds,
  )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${value?.kind === key ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select><label for="${prefix}-title">Draft title</label><input id="${prefix}-title" name="title" maxlength="160" required value="${escape(value?.title ?? "")}"><label for="${prefix}-body">Private draft text</label><textarea id="${prefix}-body" name="body" maxlength="4000" required>${escape(value?.body ?? "")}</textarea><label class="check"><input type="checkbox" name="sample_only" value="yes" required><span>I used only invented or sample information. This draft remains unsent.</span></label>`;
}
export function careerPage(
  snapshot: CareerSnapshot,
  csrf: string,
  errors: string[] = [],
  draft: {
    entry?: CareerEntryInput;
    professional?: CareerDraftInput;
    editEntryId?: string;
    editDraftId?: string;
  } = {},
) {
  const intro = `<p class="eyebrow">OPTIONAL PRIVATE LOCAL PREVIEW · NO OUTREACH</p><h1>Career and professional planning</h1><p class="lead">This path is optional. Ordinary learning and projects do not need a client, contract or job title. Use invented information only.</p>${notice(errors)}`;
  if (!snapshot.enabled)
    return page(
      "Optional career planning",
      `<section class="error-page career-page">${intro}<p>Career, opportunity and contract records are off. You can choose this path without changing your learning goals or milestones.</p><form method="post" action="/career/enable">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Turn on optional private career planning</span></label><button type="submit">Turn on career planning</button></form><p><a href="/learn">Return to learning</a></p></section>`,
    );
  const entries = snapshot.entries
    .map((item) => {
      const url = `/career/entries/${encodeURIComponent(item.id)}`;
      return `<li><h3>${escape(item.title)}</h3><p>${escape(item.kind)} · private</p><p>Note: ${escape(item.note || "None yet")}</p><p>Next action: ${escape(item.nextAction)}</p><p>Outcome: ${item.selfReportedOutcome ? `${escape(item.selfReportedOutcome)} · self-reported, not verified` : "None reported"}</p><details ${item.id === draft.editEntryId ? "open" : ""}><summary>Edit this planning record</summary><form method="post" action="${url}/update">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}">${careerEntryFields(`entry-${item.id}`, item.id === draft.editEntryId ? draft.entry : item)}<button type="submit">Save planning record</button></form></details><form method="post" action="${url}/delete">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete this planning record</span></label><button class="secondary" type="submit">Delete planning record</button></form></li>`;
    })
    .join("");
  const drafts = snapshot.drafts
    .map((item) => {
      const url = `/career/drafts/${encodeURIComponent(item.id)}`;
      return `<li><h3>${escape(item.title)}</h3><p>${escape(item.kind)} · ${item.approved ? "member approved" : "unapproved"} · unsent</p><p>${escape(item.body)}</p><details ${item.id === draft.editDraftId ? "open" : ""}><summary>Edit this private draft</summary><form method="post" action="${url}/update">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}">${careerDraftFields(`draft-${item.id}`, item.id === draft.editDraftId ? draft.professional : item)}<button type="submit">Save draft changes</button></form></details><form method="post" action="${url}/${item.approved ? "revoke" : "approve"}">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${item.approved ? "Withdraw approval for this draft" : "Approve this exact private draft version; it remains unsent"}</span></label><button type="submit">${item.approved ? "Withdraw approval" : "Approve private draft"}</button></form><form method="post" action="${url}/delete">${hidden(csrf)}<input type="hidden" name="version" value="${item.version}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete this private draft</span></label><button class="secondary" type="submit">Delete private draft</button></form></li>`;
    })
    .join("");
  return page(
    "Optional career planning",
    `<section class="error-page career-page">${intro}<p>Everything here stays private and unsent. Approval marks one saved draft version for your own planning; editing resets it. Outcomes are your own reports, not verified employment or income.</p><h2>Career, opportunity and contract plans</h2>${entries ? `<ul class="career-list">${entries}</ul>` : "<p>No optional planning records yet.</p>"}<h3>Add a planning record</h3><form method="post" action="/career/entries">${hidden(csrf)}${careerEntryFields("new-entry", draft.editEntryId ? undefined : draft.entry)}<button type="submit">Save planning record</button></form><h2>Private professional drafts</h2>${drafts ? `<ul class="career-list">${drafts}</ul>` : "<p>No private professional drafts yet.</p>"}<h3>Add an unsent draft</h3><form method="post" action="/career/drafts">${hidden(csrf)}${careerDraftFields("new-draft", draft.editDraftId ? undefined : draft.professional)}<button type="submit">Save unsent draft</button></form><h2>Leave this optional path</h2><form method="post" action="/career/disable">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete all optional career records and drafts; keep my learning milestones</span></label><button class="secondary" type="submit">Turn off and delete career planning</button></form><p><a href="/learn">Return to learning</a></p></section>`,
  );
}
export function welcome(csrf: string, error: string[] = []) {
  return page(
    "A practical start with AI",
    `<section class="hero"><div><p class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</p><h1>Find your place<br>in the future of <em>AI.</em></h1><p class="lead">A little curiosity. A useful skill. Something you can put into practice today.</p><div class="pill-row"><span>No coding required</span><span>Learn at your pace</span><span>Built for different starting points</span></div></div><aside class="path-card"><span class="eyebrow">YOUR FIRST SMALL WIN</span><h2>A clearer instruction.<br>A more useful result.</h2><p>Learn how to give AI context, set a useful task and check its answer.</p><div class="path-step"><b>01</b><span>Choose your direction</span></div><div class="path-step"><b>02</b><span>Learn one practical idea</span></div><div class="path-step"><b>03</b><span>Try it. Check it. Keep it.</span></div><p class="small">12 minutes · One guided exercise</p></aside></section><section class="onboard"><div><p class="eyebrow">MAKE THIS YOUR STARTING POINT</p><h2>What brings you here?</h2><p>Choose an example that feels useful to you, whether you are exploring AI, applying it at work or building something new.</p><p class="small">Your work stays on this computer. This browser can access it for up to 30 days; clearing its cookie loses access. Use Delete this preview to remove your saved work.</p></div><form method="post" action="/start">${hidden(csrf)}${notice(error)}${profileFields()}<label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I'll use invented or sample information in this preview.</span></label><button type="submit">Start my learning path <span aria-hidden="true">↗</span></button></form></section>`,
  );
}
export function dashboard(
  learner: Learner,
  progress: Exercise | undefined,
  csrf: string,
  errors: string[] = [],
  assignments: ContentVersion[] = [],
  choice: AssignmentChoice | null = null,
) {
  const done = Boolean(progress?.completed_at);
  const status = done
    ? "Completed · self-assessed"
    : progress
      ? "Draft saved"
      : "Ready when you are";
  const plan = learningPlan(learner);
  const time = learner.weeklyMinutes
    ? WEEKLY_TIME[learner.weeklyMinutes as keyof typeof WEEKLY_TIME]
    : undefined;
  return page(
    "Your learning path",
    `<section class="dashboard-head"><div><p class="eyebrow">YOUR LEARNING SPACE</p><h1>Small steps.<br><em>Useful skills.</em></h1><p class="lead">${GOALS[learner.goal]}</p><span class="subtle-tag">${BACKGROUNDS[learner.background]}</span></div><aside class="progress-card"><p class="eyebrow">YOUR PROGRESS</p><strong>${done ? "1" : "0"}<small> / 1</small></strong><p>exercise completed</p><progress aria-label="Exercises completed" value="${done ? 1 : 0}" max="1"></progress><span class="small">Completion records your own practice, not a formal assessment.</span></aside></section><section class="learning-plan" aria-labelledby="learning-plan-title"><p class="eyebrow">PRIVATE FOUNDATION PREVIEW</p><h2 id="learning-plan-title">Your starter plan</h2><p>Focus: ${escape(plan.focus)}. ${escape(plan.guidance)}</p><p class="small">Weekly time: ${escape(time ?? "Not specified")} · Time zone: ${escape(learner.timezone ?? "Not specified")} · AI experience: self-reported ${escape(learner.experience ? EXPERIENCE[learner.experience] : "Not specified")}</p><ol>${plan.steps.map((step) => `<li>${step.minutes} minutes · ${escape(step.action)}</li>`).join("")}</ol>${plan.nextSession ? `<p>${escape(plan.nextSession)}</p>` : ""}${plan.exploratory ? `<p>${escape(plan.exploratory)}</p>` : ""}<p class="small">Only the local starter lesson is available here. Revisit or skip steps you already completed. These suggestions do not book coaching or certify a skill.</p></section>${assignmentSection(assignments, choice, csrf)}<section class="learning-grid"><article class="lesson-card"><p class="eyebrow">FOUNDATION · LESSON 01</p><span class="status">${status}</span><h2>${LESSON.title}</h2><p>Context. A clear task. A way to check the answer. Three things that make a better starting point.</p><p class="small">${LESSON.minutes} minutes · No coding · Version ${LESSON.version}</p><a class="button" href="/lesson">${done ? "Review your work" : progress ? "Continue exercise" : "Open lesson"} <span aria-hidden="true">↗</span></a></article><aside class="next-card"><p class="eyebrow">WHERE THIS CAN GO</p><h2>Learn together.<br>Contribute something useful.</h2><p>Learning circles, peer contributions and more paths are on the roadmap. This preview begins with your first practical exercise.</p><p class="small">Community and coaching features are not yet available.</p></aside></section><p><a class="button secondary" href="/library">Browse published learning library</a> <a class="button secondary" href="/milestones">Plan goals and milestones</a> <a class="button secondary" href="/career">Explore optional career planning</a> <a class="button secondary" href="/contribute">Draft a private sample contribution</a></p><section class="profile-form"><h2>Adjust your direction</h2><p>Change goals and interests whenever you want. Your saved exercise stays with this preview.</p><form method="post" action="/profile">${hidden(csrf)}${notice(errors)}${profileFields(learner)}<button type="submit">Save my direction</button></form></section><form class="delete-form" method="post" action="/delete">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete my local preview and all its saved work.</span></label><button class="secondary" type="submit">Delete this preview</button></form>`,
  );
}
export function lesson(
  learner: Learner,
  progress: Exercise | undefined,
  csrf: string,
  errors: SubmissionError[] = [],
) {
  const prompt = exercise(progress?.goal_at_start ?? learner.goal);
  const done = Boolean(progress?.completed_at);
  const fieldError = (field: SubmissionField) =>
    errors.find((error) => error.field === field)?.message;
  const instructionError = fieldError("instruction");
  const verificationError = fieldError("verification");
  const checkedError = fieldError("checked");
  const summary = errors.length
    ? `<div class="notice" role="alert"><h2>Fix the exercise form</h2><ul>${errors.map((error) => `<li>${error.field ? `<a href="#${error.field}">${escape(error.message)}</a>` : escape(error.message)}</li>`).join("")}</ul></div>`
    : "";
  return page(
    errors.length ? "Error in your exercise" : LESSON.title,
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a><span>FOUNDATION / 01</span></nav><section class="lesson-heading"><p class="eyebrow">${LESSON.minutes} MINUTES · VERSION ${LESSON.version}</p><h1>${LESSON.title}</h1><p class="lead">AI can produce a confident answer to an unclear question. Give it something concrete to work with—and decide how you'll check the result.</p>${progress?.goal_at_start && progress.goal_at_start !== learner.goal ? '<p class="small">This saved practice remains tied to your earlier goal. Your current direction is shown on your learning path.</p>' : ""}</section><div class="lesson-layout"><article class="reading"><section><span class="number">01</span><h2>Give it context</h2><p>Explain the situation using information you have permission to share. Use sample details when practising. Leave out names, secrets and private client information.</p></section><section><span class="number">02</span><h2>Ask for a useful outcome</h2><p>Name the task, audience and format. Set limits such as length, time or available resources. Ask it to identify missing information instead of guessing.</p></section><section><span class="number">03</span><h2>Decide how you'll check</h2><p>Compare facts against your original material or a reliable source. Check whether the answer fits the task. An AI suggestion is a starting point; you remain responsible for how you use it.</p></section><aside class="example"><p class="eyebrow">A CHECK FOR YOUR EXERCISE</p><p>${prompt.check}</p></aside></article><section class="exercise-card" aria-labelledby="exercise-title"><p class="eyebrow">PUT IT INTO PRACTICE</p><h2 id="exercise-title">${prompt.title}</h2><p>${prompt.brief}</p>${summary}${done ? `<div class="success" role="status"><strong>Exercise completed</strong><p>Self-assessed practice saved. No AI or qualified reviewer has assessed it.</p></div><h3>Your instruction</h3><p class="saved-answer">${escape(progress!.instruction)}</p><h3>Your way to check</h3><p class="saved-answer">${escape(progress!.verification)}</p><a class="button" href="/learn">See your progress</a>` : `<form method="post" action="/exercise">${hidden(csrf)}<label for="instruction">Your instruction to AI</label><textarea id="instruction" name="instruction" maxlength="2000" rows="5" aria-describedby="answer-help${instructionError ? " instruction-error" : ""}"${instructionError ? ' aria-invalid="true"' : ""}>${escape(progress?.instruction ?? "")}</textarea><p id="answer-help" class="small">Use at least 20 characters to complete. You can save an unfinished draft.</p>${instructionError ? `<p id="instruction-error" class="field-error">${escape(instructionError)}</p>` : ""}<label for="verification">How will you check the result?</label><textarea id="verification" name="verification" maxlength="1000" rows="3" aria-describedby="verification-help${verificationError ? " verification-error" : ""}"${verificationError ? ' aria-invalid="true"' : ""}>${escape(progress?.verification ?? "")}</textarea><p id="verification-help" class="small">Use at least 20 characters to complete. You can save an unfinished draft.</p>${verificationError ? `<p id="verification-error" class="field-error">${escape(verificationError)}</p>` : ""}<label class="check"><input id="checked" type="checkbox" name="checked" value="yes"${checkedError ? ' aria-invalid="true" aria-describedby="checked-error"' : ""}><span>I checked the context, task and verification plan, and used only sample information.</span></label>${checkedError ? `<p id="checked-error" class="field-error">${escape(checkedError)}</p>` : ""}<div class="actions"><button type="submit" name="intent" value="complete">Complete exercise</button><button type="submit" name="intent" value="draft" class="secondary">Save draft</button></div>${progress && !errors.length ? '<p class="saved-note" role="status">Your draft is saved. You can return in this browser.</p>' : ""}</form>`}</section></div>`,
  );
}
export function errorPage(title: string, message: string) {
  return page(
    title,
    `<section class="error-page"><p class="eyebrow">A SMALL PAUSE</p><h1>${escape(title)}</h1><p class="lead">${escape(message)}</p><a class="button" href="/learn">Return to your learning path</a></section>`,
  );
}
export function libraryPage(
  items: ContentVersion[],
  filters: { q: string; goal?: string; background?: string; domain?: string },
) {
  const select = (
    name: string,
    label: string,
    options: object,
    chosen?: string,
  ) =>
    `<label for="library-${name}">${label}</label><select id="library-${name}" name="${name}"><option value="">All</option>${Object.entries(
      options,
    )
      .map(
        ([value, text]) =>
          `<option value="${value}"${chosen === value ? " selected" : ""}>${escape(text)}</option>`,
      )
      .join("")}</select>`;
  return page(
    "Published learning library",
    `<section class="lesson-heading"><p class="eyebrow">LOCAL PREVIEW · PUBLISHED VERSIONS ONLY</p><h1>Learning library</h1><p class="lead">Search released sample content. Drafts and retired versions are hidden; formal assessment is unavailable.</p><form method="get" action="/library"><label for="library-q">Search lessons and exercises</label><input id="library-q" name="q" value="${escape(filters.q)}" maxlength="100">${select("goal", "Goal", GOALS, filters.goal)}${select("background", "Background", BACKGROUNDS, filters.background)}${select("domain", "Domain", DOMAINS, filters.domain)}<button type="submit">Search</button></form></section><section aria-label="Published content"><ul>${items.map((item) => `<li><a href="/library/${escape(item.id)}">${escape(item.title)}</a> · ${escape(item.kind)} · version ${item.version} · ${escape(item.origin)}</li>`).join("")}</ul>${items.length ? "" : "<p>No published content matches. The foundation content pack is still awaiting qualified review.</p>"}</section><p><a href="/learn">Return to your learning path</a></p>`,
  );
}
export function contentPreview(
  item: ContentVersion,
  staff: boolean,
  csrf = "",
) {
  const base = `/editor/library/${encodeURIComponent(item.id)}/${item.version}`;
  return page(
    item.title,
    `<nav class="breadcrumb"><a href="${staff ? "/editor/library" : "/library"}">← ${staff ? "Staff content" : "Learning library"}</a></nav><article class="reading"><p class="eyebrow">${staff ? "STAFF PREVIEW · " : "LOCAL PUBLISHED PREVIEW · "}${escape(item.state.toUpperCase())} · VERSION ${item.version}</p><h1>${escape(item.title)}</h1><p>${escape(item.kind)} · ${escape(item.origin)}</p><dl><dt>Owner</dt><dd>${escape(item.owner)}</dd><dt>Sources</dt><dd>${escape(item.sources)}</dd><dt>Rights</dt><dd>${escape(item.rights)}</dd><dt>Goals</dt><dd>${escape(item.goals.join(", ") || "All")}</dd><dt>Backgrounds</dt><dd>${escape(item.backgrounds.join(", ") || "All")}</dd><dt>Domains</dt><dd>${escape(item.domains.join(", ") || "All")}</dd><dt>Suggested experience</dt><dd>${escape(EXPERIENCE[item.minimumExperience ?? "new"])} (self-reported)</dd><dt>Prerequisites</dt><dd>${escape(item.prerequisites || "None")}</dd><dt>Review date</dt><dd>${item.reviewedAt ? escape(item.reviewedAt.toISOString().slice(0, 10)) : "Pending"}</dd></dl>${item.requiresQualifiedSignoff ? '<p role="status">Qualified curriculum and domain sign-off is pending. This draft cannot be approved or published.</p>' : ""}<h2>Content text</h2><pre class="content-text">${escape(item.body)}</pre>${item.rubric ? `<h2>Versioned rubric ${item.rubricVersion}</h2><pre class="content-text">${escape(item.rubric)}</pre>` : ""}${staff ? `<section aria-label="Content workflow"><form method="post" action="${base}/submit">${hidden(csrf)}<button>Submit for review</button></form><form method="post" action="${base}/approve">${hidden(csrf)}<label class="check"><input type="checkbox" name="rights_confirmed" value="yes" required><span>I checked the source and rights statement for this synthetic item.</span></label><button>Approve synthetic review</button></form><form method="post" action="${base}/publish">${hidden(csrf)}<button>Publish to local library</button></form><form method="post" action="/editor/library/${encodeURIComponent(item.id)}/retire">${hidden(csrf)}<button>Retire published versions</button></form></section>` : ""}</article>`,
  );
}
export function staffLibraryPage(items: ContentVersion[], csrf: string) {
  return page(
    "Staff content drafts",
    `<section class="lesson-heading"><p class="eyebrow">LOCAL STAFF PREVIEW</p><h1>Content workflow</h1><p>PLAN-004 assets are unreviewed drafts and require separate qualified sign-off. Synthetic staff testing does not supply that approval.</p></section><ul>${items.map((item) => `<li><a href="/editor/library/${escape(item.id)}/${item.version}">${escape(item.title)}</a> · ${escape(item.state)} · version ${item.version}</li>`).join("")}</ul><section><h2>Create a synthetic draft</h2><form method="post" action="/editor/library">${hidden(csrf)}<label for="content-id">Content ID</label><input id="content-id" name="id" required pattern="[A-Z]{2,5}-[0-9]{3}"><label for="content-version">Version</label><input id="content-version" name="version" type="number" min="1" required><label for="content-kind">Kind</label><select id="content-kind" name="kind"><option value="lesson">Lesson</option><option value="assignment">Assignment</option><option value="workflow">Workflow</option><option value="community">Community</option></select><label for="content-title">Title</label><input id="content-title" name="title" required><label for="content-body">Body</label><textarea id="content-body" name="body" required></textarea><label for="content-owner">Owner</label><input id="content-owner" name="owner" required><label for="content-sources">Sources</label><input id="content-sources" name="sources" required><label for="content-rights">Rights</label><input id="content-rights" name="rights" required><label for="content-minimum-experience">Suggested experience</label><select id="content-minimum-experience" name="minimum_experience"><option value="new">Just starting</option><option value="some">Some practice</option><option value="experienced">Experienced</option></select><label for="content-prerequisites">Prerequisites</label><input id="content-prerequisites" name="prerequisites" placeholder="None or LOCAL-FIRST-EXERCISE-COMPLETE"><p class="small">Unrecognized prerequisites remain unavailable for member selection.</p><button type="submit">Save draft</button></form></section>`,
  );
}
