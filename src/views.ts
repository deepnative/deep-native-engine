import { randomUUID } from "node:crypto";
import type { MemberExportPayload } from "./member-export.ts";
import {
  BACKGROUNDS,
  GOALS,
  DOMAINS,
  IT_ROLES,
  EXPERIENCE,
  WEEKLY_TIME,
  LESSON,
  exercise,
  type Domain,
} from "./content.ts";
import type {
  Learner,
  Exercise,
  ExerciseHistory,
  AssignmentChoice,
  Milestone,
  LessonActivity,
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
import { effectivePrerequisiteSpec } from "./prerequisites.ts";
import type { ExpertRecord, TrackSnapshot } from "./track-readiness.ts";
import type { Proposal, OwnerProposal } from "./proposals.ts";
import type { WorkflowBundle } from "./workflow-registry.ts";
import type { WorkflowFeedback } from "./workflow-feedback.ts";
import type { ManualObservation } from "./manual-observations.ts";
import type { CircleListing } from "./circles.ts";
import type {
  AssignmentAttempt,
  AssignmentAttemptListItem,
  AssignmentSubmission,
} from "./attempts.ts";
import type { compareResponses } from "./attempt-compare.ts";
import type { ActivityItem } from "./progress.ts";
import type { UsefulnessReport } from "./usefulness.ts";
import type { PracticeHistory, PracticeSource } from "./practice.ts";
import type {
  PracticeSessionSource,
  PracticeSessionSummary,
  PracticeSessionDetail,
} from "./practice-sessions.ts";
import type { OwnedEvidence } from "./evidence.ts";
import type { LocalAiChoice } from "./local-ai-consent.ts";
import { localSlotTime, type AvailableSlot } from "./availability.ts";
import type { MemberHoldSnapshot, SampleHoldReceipt } from "./slot-holds.ts";
import type { EventPreview, EventPreviewDetail } from "./events.ts";
import type {
  AssignmentReadiness,
  ReadinessRequirement,
} from "./assignment-readiness.ts";
import { learningPlan } from "./learning-plan.ts";
import type {
  ProfileEditResult,
  ProfileError,
  ProfileField,
  ProfileFormState,
  ProfileStartResult,
  SubmissionError,
  SubmissionField,
} from "./validation.ts";
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Deep Native Engine</title><link rel="stylesheet" href="/assets/style.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">d/n</span> deep native<span class="brand-light">engine</span></a><span class="preview-tag">LOCAL LEARNING PREVIEW</span></header><main id="main">${body}</main><footer><strong>Learn something. Make something. Share what works.</strong><span>Local preview · Use sample information only. No AI provider, payment or formal assessment is connected. <a href="/circles">Local circles</a> · <a href="/workflows">Workflow demonstrations</a> · <a href="/readiness">Integration readiness</a>.</span></footer></body></html>`;
}
export function memberExportPage(
  payload: MemberExportPayload,
  cursor?: string,
) {
  const query =
    cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return page(
    "Download private preview records",
    `<p><a href="/learn">Back to your learning space</a></p>
    <h1>Download private preview records</h1>
    <p>Download every page to collect the retained structured records. Each page is a live read, not one frozen snapshot. If records change during the export, start again. This excludes evidence bytes, audit, billing, provider and backup copies.</p>
    <p>Your retained local test-unit history includes grants, holds, events and recorded settlements, including expired and released units. Available quantities are stored counters, not current usable balances or paid allowances. Each downloaded page includes its database observation time.</p>
    <p>Each page contains at most 100 records and 256 KiB. Continuation expires after 15 minutes or a server restart. Access is checked again for every page and download.</p>
    <h2>Page ${payload.page.number}</h2>
    <section data-member-export data-url="/api/member/export${escape(query)}">
      <p>Download reads the current page again. The next link comes from that downloaded file.</p>
      <button type="button">Download page ${payload.page.number}</button>
      <p role="status">Download this page to reveal the next step.</p>
      <p><a data-export-next hidden>Next page</a></p>
    </section><script type="module" src="/assets/member-export.js"></script>
    <p><a href="/member/export">Start export again</a></p>`,
  );
}
export function evidenceExportPage(number: number, cursor?: string) {
  const query =
    cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return page(
    "Download private evidence",
    `<p><a href="/evidence">Back to private evidence</a></p>
    <h1>Download private evidence</h1>
    <p>Download every page to collect current sample metadata and clean source bytes encoded as base64. Each page is a live read, not one frozen snapshot. If samples or consent change during export, start again. Pending, rejected, infected and deleting source bytes, derivatives and hosted copies are excluded.</p>
    <p>Each page contains at most 20 samples and 4 MiB of raw clean source data. JSON is larger because sources are encoded as base64. Continuation expires after 15 minutes. Access is checked again for every page and download.</p>
    <h2>Page ${number}</h2>
    <section data-evidence-export data-url="/api/evidence/export${escape(query)}">
      <p>Download reads the current page again. The next link comes from that downloaded file.</p>
      <button type="button">Download page ${number}</button>
      <p role="status">Download this page to reveal the next step.</p>
      <p><a data-export-next hidden>Next page</a></p>
    </section><script type="module" src="/assets/evidence-export.js"></script>
    <p><a href="/evidence/export">Start export again</a></p>`,
  );
}
export function notice(errors: string[]) {
  return errors.length
    ? `<div class="notice" role="alert"><h2>Let's fix that</h2><ul>${errors.map((e) => `<li>${escape(e)}</li>`).join("")}</ul></div>`
    : "";
}
export function hidden(csrf: string) {
  return `<input type="hidden" name="csrf" value="${csrf}">`;
}
function profileFields(
  learner?: Learner,
  attempted?: ProfileFormState,
  errors: ProfileError[] = [],
) {
  const fieldError = (field: ProfileField) =>
    errors.find((error) => error.field === field)?.message;
  const errorText = (field: ProfileField) => {
    const message = fieldError(field);
    return message
      ? `<p id="${field}-error" class="field-error">${escape(message)}</p>`
      : "";
  };
  const select = (
    name: ProfileField,
    label: string,
    choices: Record<string, string>,
    selected?: string | null,
    required = false,
  ) => {
    const invalid = Boolean(fieldError(name));
    return `<label for="${name}">${label}</label><select id="${name}" name="${name}" ${required ? "required" : ""}${invalid ? ` aria-invalid="true" aria-describedby="${name}-error"` : ""}><option value=""${selected === "" ? " selected" : ""}>${required ? "Choose one" : "Not specified"}</option>${Object.entries(
      choices,
    )
      .map(
        ([key, value]) =>
          `<option value="${key}" ${selected === key ? "selected" : ""}>${value}</option>`,
      )
      .join("")}</select>${errorText(name)}`;
  };
  const checks = (
    name: ProfileField,
    label: string,
    choices: Record<string, string>,
    selected: readonly string[],
  ) => {
    const invalid = Boolean(fieldError(name));
    return `<fieldset id="${name}" tabindex="-1"${invalid ? ` aria-invalid="true" aria-describedby="${name}-error"` : ""}><legend>${label}</legend><div class="option-grid">${Object.entries(
      choices,
    )
      .map(
        ([key, value]) =>
          `<label class="check"><input type="checkbox" name="${name}" value="${key}" ${selected.includes(key) ? "checked" : ""}><span>${value}</span></label>`,
      )
      .join("")}</div></fieldset>${errorText(name)}`;
  };
  const timezoneError = fieldError("timezone");
  const exploratoryError = fieldError("exploratory");
  return `${select("background", "Your starting point", BACKGROUNDS, attempted ? attempted.background : learner?.background, true)}
    ${select("goal", "What would you like to do?", GOALS, attempted ? attempted.goal : learner?.goal, true)}
    <p class="small">You can add more interests or change your goal later. These choices never determine admission or payment.</p>
    ${checks("background_tags", "Other starting points (optional)", BACKGROUNDS, attempted ? attempted.backgroundTags : (learner?.backgroundTags ?? []))}
    ${checks("domain_tags", "Domains of interest (optional)", DOMAINS, attempted ? attempted.domainTags : (learner?.domainTags ?? []))}
    ${checks("it_roles", "IT specialties (optional)", IT_ROLES, attempted ? attempted.itRoles : (learner?.itRoles ?? []))}
    ${select("experience", "Experience with AI (optional)", EXPERIENCE, attempted ? attempted.experience : learner?.experience)}
    <label for="timezone">Time zone (optional)</label><input type="text" id="timezone" name="timezone" value="${escape(attempted ? attempted.timezone : (learner?.timezone ?? ""))}" maxlength="64" placeholder="e.g. America/Toronto" aria-describedby="timezone-help${timezoneError ? " timezone-error" : ""}"${timezoneError ? ' aria-invalid="true"' : ""}><p id="timezone-help" class="small">Use a location-style time zone. This preview does not schedule appointments.</p>${errorText("timezone")}
    ${select("weekly_minutes", "Weekly time available (optional)", WEEKLY_TIME, attempted ? attempted.weeklyMinutes : learner?.weeklyMinutes?.toString())}
    <label class="check"><input id="exploratory" type="checkbox" name="exploratory" value="yes" ${attempted ? (attempted.exploratory ? "checked" : "") : learner?.exploratory ? "checked" : ""}${exploratoryError ? ' aria-invalid="true" aria-describedby="exploratory-error"' : ""}><span>Keep an exploratory path open alongside my primary goal.</span></label>${errorText("exploratory")}`;
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
    `<section class="error-page"><p class="eyebrow">LOCAL PREVIEW · NO SERVICE BOOKINGS</p><h1>Learning track readiness</h1><p class="lead">Foundation lessons await qualified curriculum sign-off. Specialist services also need reviewed content and current, verified expert coverage. These states do not grant coaching, formal review or admission.</p><h2>Shared foundation</h2><ul>${snapshot.foundation.map(({ goal, state }) => `<li><strong>${escape(GOALS[goal])}</strong> · ${escape(state)}</li>`).join("")}</ul><h2>IT specialty services</h2><p>No IT specialty service has qualified content and capacity evidence in this preview.</p><ul>${snapshot.itSpecialties.map(({ role, state }) => `<li><strong>${escape(IT_ROLES[role])}</strong> · ${escape(state)}</li>`).join("")}</ul><h2>Specialist domains and services</h2><p>Each listed gap describes evidence missing from the current local registry, not a promise of an available service.</p><ul>${snapshot.specialties.map(({ domain, serviceType, state, gaps }) => `<li><strong>${escape(DOMAINS[domain])} · ${escape(serviceType)}</strong> · ${escape(state)}${gaps.map((gap) => ` · ${escape(gap)}`).join("")}</li>`).join("")}</ul><p>General learners may use the separate local preview exercise without a specialist fit review. Tailored service cannot be committed from this page.</p><a href="/readiness">Integration readiness</a></section>`,
  );
}
export function tailoredReviewRequestPage(csrf: string, errors: string[] = []) {
  return page(
    "Check tailored review",
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a></nav><section class="error-page"><p class="eyebrow">OPTIONAL LOCAL PREVIEW · NO BOOKINGS</p><h1>Check tailored-review availability</h1><p>This check asks whether a formal review is available for a domain. It does not submit an application, save your choice, reserve a reviewer, charge you or accept a service request.</p>${notice(errors)}<form method="post" action="/tailored-review">${hidden(csrf)}<label for="review-domain">Review domain</label><select id="review-domain" name="domain" required><option value="">Choose a domain</option>${Object.entries(
      DOMAINS,
    )
      .map(([id, label]) => `<option value="${id}">${escape(label)}</option>`)
      .join(
        "",
      )}</select><button type="submit">Check tailored review</button></form><p><a href="/readiness/tracks">See all learning track readiness</a></p></section>`,
  );
}
export function availabilityPage(
  slots: AvailableSlot[],
  timezone?: string,
  error?: string,
  holds?: {
    csrf: string;
    requestIds: Record<string, string>;
    snapshot: MemberHoldSnapshot;
  },
) {
  const zone = timezone?.trim() || "";
  const display = zone ? localSlotTime(new Date(), zone) : null;
  const slotForm = (slot: AvailableSlot) => {
    const grants =
      holds?.snapshot.grants.filter(
        (grant) =>
          grant.category ===
          (slot.serviceType === "coaching"
            ? "coach_minutes"
            : "review_minutes"),
      ) ?? [];
    if (!holds || !grants.length)
      return "<p>No matching current test allowance has 60 available minutes. No allowance is created here.</p>";
    return `<form method="post" action="/availability/holds">${hidden(holds.csrf)}<input type="hidden" name="slotId" value="${escape(slot.id)}"><input type="hidden" name="requestId" value="${escape(holds.requestIds[slot.id]!)}"><label for="grant-${escape(slot.id)}">Explicit test allowance</label><select id="grant-${escape(slot.id)}" name="grantId">${grants.map((grant, index) => `<option value="${escape(grant.id)}">${escape(grant.category)} · test allowance ${index + 1}</option>`).join("")}</select><button type="submit">Reserve sample hold</button></form>`;
  };
  return page(
    "Optional service availability",
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a></nav><section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · NO BOOKINGS</p><h1>Optional service availability</h1><p><a href="/member/test-units">View your local test units</a> before making a sample request.</p><p>This page shows sample appointment windows only. Real expert capacity, paid access, provider notification, calendar/email delivery, cancellation and service fulfillment are unavailable.</p><p>A sample hold reserves 60 explicitly seeded test minutes for at most 10 minutes and always ends at least one second before the window starts. This test-only deadline creates no commercial cancellation or no-show term.</p>${error ? `<div class="notice" role="alert"><p>${escape(error)}</p></div>` : ""}${display ? `<p>Times shown for ${escape(zone)}. Each window also shows its exact UTC time.</p>` : '<p>Choose a valid time zone in your <a href="/learn">profile form</a> to see local appointment times.</p>'}${slots.length && display ? `<ul>${slots.map((slot) => `<li><strong>${escape(DOMAINS[slot.domain as Domain] ?? slot.domain)} · ${escape(slot.serviceType)}</strong><br><time datetime="${slot.startsAt.toISOString()}">${escape(localSlotTime(slot.startsAt, zone) ?? slot.startsAt.toISOString())}</time> to <time datetime="${slot.endsAt.toISOString()}">${escape(localSlotTime(slot.endsAt, zone) ?? slot.endsAt.toISOString())}</time> · UTC ${slot.startsAt.toISOString()} to ${slot.endsAt.toISOString()} · sample window, not bookable${slotForm(slot)}</li>`).join("")}</ul>` : '<p role="status">No sample windows can be shown right now. Your shared learning path remains available.</p>'}<h2>Your private sample receipts</h2>${holds?.snapshot.receipts.length ? `<ul>${holds.snapshot.receipts.map((item) => `<li><a href="/availability/holds/${escape(item.id)}">Sample hold receipt · ${escape(item.state)} · ${item.startsAt.toISOString()}</a></li>`).join("")}</ul>` : "<p>No sample hold receipts are currently visible for your session.</p>"}<p>Availability may change. A listed window is never a reservation. Background, interests and shared learning membership grant no service minutes.</p><a href="/learn">Continue shared learning</a></section>`,
  );
}

export function sampleHoldReceiptPage(
  receipt: SampleHoldReceipt,
  timezone?: string,
  csrf?: string,
) {
  const local = timezone ? localSlotTime(receipt.startsAt, timezone) : null;
  const zone = local ? timezone! : "UTC";
  const windowLabel = local
    ? "Member-local window"
    : "UTC display window (no valid member time zone)";
  return page(
    "Your sample hold receipt",
    `<section class="reading"><p class="eyebrow">SAMPLE HOLD — NOT A BOOKING</p><h1>Your sample hold receipt</h1><dl><dt>State</dt><dd>${escape(receipt.state)}</dd><dt>Sample service</dt><dd>${escape(DOMAINS[receipt.domain as Domain] ?? receipt.domain)} · ${escape(receipt.serviceType)}</dd><dt>Slot</dt><dd>${escape(receipt.slotId)}</dd><dt>Exact UTC window</dt><dd>${receipt.startsAt.toISOString()} to ${receipt.endsAt.toISOString()}</dd><dt>${windowLabel}</dt><dd>${escape(localSlotTime(receipt.startsAt, zone)!)} to ${escape(localSlotTime(receipt.endsAt, zone)!)}</dd><dt>Reserved test quantity</dt><dd>${receipt.quantity} minutes</dd><dt>Test-only deadline</dt><dd>${receipt.expiresAt.toISOString()} · ${escape(localSlotTime(receipt.expiresAt, zone)!)}</dd></dl><p>${receipt.state === "released" ? "You withdrew this sample hold. Its slot and test-minute reservation are released. Units return only while the original test grant remains current; otherwise those units stay expired." : receipt.state === "expired" ? "This temporary hold has expired. Reserved units return only while the original test grant and member access remain current; otherwise those units stay expired." : "This temporary hold lasts at most 10 minutes and ends before the sample window starts. Reload this receipt to inspect its current state."}</p>${receipt.state === "held" && csrf ? `<form method="post" action="/availability/holds/${escape(receipt.id)}/withdraw">${hidden(csrf)}<p>Withdraw this temporary sample hold to release its slot and test-minute reservation. Your original receipt remains available.</p><button type="submit">Withdraw sample hold</button></form>` : ""}<p>Real expert capacity, paid access, provider notification, calendar/email delivery, cancellation and service fulfillment are unavailable. This is no commercial cancellation or no-show term.</p><p><a href="/availability/holds/${escape(receipt.id)}">Reload this receipt</a> · <a href="/availability">Inspect your current sample receipts</a></p></section>`,
  );
}

export function sampleHoldRecoveryPage(
  requestId: string | null,
  message: string,
) {
  return page(
    "Inspect your sample hold",
    `<section class="error-page"><p class="eyebrow">SAMPLE HOLD — NOT A BOOKING</p><h1>Inspect your sample hold</h1><p role="alert">${escape(message)}</p>${requestId ? `<p><a href="/availability/holds/${escape(requestId)}">Inspect this request's receipt</a></p>` : ""}<p><a href="/availability">Inspect your current sample receipts</a> before trying a new request.</p></section>`,
  );
}
export function tailoredReviewUnavailablePage(
  service: TrackSnapshot["specialties"][number],
  domain: Domain,
) {
  const publicGaps = [
    "Reviewed content not verified",
    "Qualified reviewer coverage not verified",
    "Deliverable service capacity not verified",
  ].filter((gap) => service.gaps.includes(gap));
  return page(
    "Tailored review unavailable",
    `<nav class="breadcrumb"><a href="/tailored-review">← Check another domain</a></nav><section class="error-page" role="status"><p class="eyebrow">NO REQUEST ACCEPTED</p><h1>Tailored review is unavailable</h1><p>The latest readiness state for ${escape(DOMAINS[domain])} formal review is ${escape(service.state)}. Requests are not open in this preview. No request was accepted or saved, no reviewer was reserved, and no payment or paid access was granted.</p>${publicGaps.length ? `<h2>What is missing</h2><ul>${publicGaps.map((gap) => `<li>${escape(gap)}</li>`).join("")}</ul>` : "<p>Approved request terms are not available in this preview.</p>"}<p>You can continue with the common local foundation without tailored review.</p><a href="/learn">Return to your learning path</a></section>`,
  );
}
export function expertRegistryPage(records: ExpertRecord[]) {
  return page(
    "Expert coverage registry",
    `<section class="error-page"><p class="eyebrow">OPERATOR VIEW · EVIDENCE PENDING</p><h1>Expert coverage registry</h1><p><a href="/operator/ledger-reconciliation">Inspect synthetic ledger reconciliation</a></p><p class="lead">Roster records alone do not prove qualification or availability. Verify evidence, dates, backup and uncommitted capacity before any owner-approved service offer.</p><ul>${records.map((record) => `<li><strong>${escape(DOMAINS[record.domain])} · ${escape(record.serviceType)}</strong> · ${escape(record.staffRole)} · ${record.startsAt.toISOString().slice(0, 10)} to ${record.endsAt.toISOString().slice(0, 10)} · CAD ${(record.loadedCostCents / 100).toFixed(2)} loaded cost · ${record.capacityMinutes - record.committedMinutes} uncommitted minutes · backup ${record.backupStaffId ? "recorded" : "missing"} · ${record.verifiedAt ? "verification recorded" : "verification pending"}${record.retiredAt ? " · retired" : ""}</li>`).join("")}</ul>${records.length ? "" : "<p>No expert commitments are recorded.</p>"}</section>`,
  );
}
export function manualObservationPage(
  observations: ManualObservation[],
  csrf: string,
  idempotencyKey: string,
) {
  return page(
    "Unverified synthetic manual observations",
    `<section class="reading"><p class="eyebrow">INTERNAL SYNTHETIC TEST · NO LIVE PAYMENT</p><h1>Unverified manual observations</h1><p>These invented records are not provider verification, a paid invoice, a charge, service delivery or a grant of access. Enter no card, bank, client or real payment details.</p><form method="post" action="/operator/test-receipts">${hidden(csrf)}<input type="hidden" name="idempotencyKey" value="${escape(idempotencyKey)}"><label for="manual-member">Existing local member ID</label><input id="manual-member" name="memberId" required><label for="manual-evidence">Invented evidence reference (SYN- prefix)</label><input id="manual-evidence" name="evidenceReference" required><label for="manual-cents">Invented CAD cents</label><input id="manual-cents" name="amountCents" type="number" min="1" max="10000000" step="1" required><label><input type="checkbox" name="confirm" value="yes" required> This is invented test evidence, not a payment confirmation</label><button type="submit">Record unverified observation</button></form><h2>Internal test register</h2><ul>${observations.map((item) => `<li><strong>${escape(item.evidenceReference)}</strong> · member ${escape(item.memberId)} · CAD ${(item.amountCents / 100).toFixed(2)} · ${escape(item.status)} · recorded ${item.createdAt.toISOString()} · actor ${escape(item.actorId)}</li>`).join("")}</ul>${observations.length === 100 ? "<p>Showing the newest 100 synthetic observations. Older records may be present in the local test database.</p>" : observations.length ? "" : "<p>No synthetic manual observations are recorded.</p>"}</section>`,
  );
}
export function proposalListPage(
  items: Proposal[],
  csrf: string,
  workflow?: WorkflowBundle | null,
) {
  return page(
    "Your sample proposals",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SAMPLE INFORMATION ONLY</p><h1>Your sample proposals</h1><p class="lead">Draft an original example. A submitted sample stays in a private moderation queue. No contribution license, publication, expert assessment or public sharing is enabled.</p><ul>${items.map((item) => `<li><a href="/contribute/${escape(item.id)}">${escape(item.title ?? "Redacted proposal")}</a> · ${escape(item.state.replaceAll("_", " "))}</li>`).join("")}</ul>${items.length ? "" : "<p>No sample proposals yet.</p>"}<h2>${workflow ? `Private improvement for ${escape(workflow.id)} version ${workflow.version}` : "New private draft"}</h2><form method="post" action="/contribute">${hidden(csrf)}${workflow ? `<input type="hidden" name="workflow_id" value="${escape(workflow.id)}"><input type="hidden" name="workflow_version" value="${workflow.version}"><p>Reference: ${escape(workflow.title)} · version ${workflow.version}. This is only a private proposal; no public reuse rights are granted.</p>` : ""}<label for="proposal-title">Title</label><input id="proposal-title" name="title" maxlength="160" required><label for="proposal-body">Original sample</label><textarea id="proposal-body" name="body" maxlength="4000" required></textarea><label for="proposal-sources">Sources and rights notes</label><textarea id="proposal-sources" name="sources" maxlength="1000" required></textarea><label class="check"><input type="checkbox" name="sample_confirmed" value="yes" required><span>I used only invented or sample information and understand this is private.</span></label><button type="submit">Save private draft</button></form><p><a href="/learn">Return to learning</a></p></section>`,
  );
}
export function proposalPreviewPage(
  item: OwnerProposal,
  csrf: string,
  referenceCurrent = true,
) {
  const editable = item.state === "draft" || item.state === "changes_requested";
  const canEdit = editable && referenceCurrent;
  const canSubmit =
    canEdit &&
    (item.state === "draft" ||
      (item.feedback !== null &&
        item.revision > item.feedback.reviewedRevision));
  const canWithdraw = [
    "draft",
    "changes_requested",
    "submitted",
    "quarantined",
  ].includes(item.state);
  const feedback = canWithdraw ? item.feedback : null;
  return page(
    "Private proposal",
    `<section class="error-page"><p class="eyebrow">PRIVATE SAMPLE · ${escape(item.state.toUpperCase().replaceAll("_", " "))}</p><h1>${escape(item.title ?? "Redacted proposal")}</h1><p class="lead">This is not published or licensed for public reuse.</p>${item.workflowId ? `<p>Workflow reference: ${escape(item.workflowId)} version ${item.workflowVersion}</p>` : ""}${!referenceCurrent && editable ? '<p role="status">This workflow version is no longer current. You can read or withdraw this private proposal, but start a new version-pinned proposal before editing or submitting.</p>' : ""}${item.body ? `<h2>Sample</h2><p class="content-text" data-proposal-body>${escape(item.body)}</p><h2>Sources and rights notes</h2><p class="content-text">${escape(item.sources!)}</p>` : "<p>The proposal text has been removed.</p>"}${feedback ? `<section aria-label="Private requested changes"><h2>${item.state === "changes_requested" ? "Changes requested" : "Prior-cycle requested changes"}</h2><p>Private local feedback on revision ${feedback.reviewedRevision}, requested <time datetime="${feedback.requestedAt.toISOString()}">${feedback.requestedAt.toISOString()}</time>. This is not approval or qualified assessment.</p><p class="content-text" data-proposal-feedback>${escape(feedback.text)}</p><p>Only the current requested changes are retained. A later request replaces this feedback.</p></section>` : ""}${canEdit ? `<p>Saved revision ${item.revision}. Corrections stay private until you submit this exact revision.</p>${proposalEditForm(item.id, csrf, item.revision, { title: item.title!, body: item.body!, sources: item.sources! })}` : ""}${canEdit && !canSubmit ? '<p role="status">Save a correction after the reviewed revision before resubmitting. Then confirm rights again for the corrected revision.</p>' : ""}${canSubmit ? `<form method="post" action="/contribute/${escape(item.id)}/submit">${hidden(csrf)}<input type="hidden" name="revision" value="${item.revision}"><label class="check"><input type="checkbox" name="rights_confirmed" value="yes" required><span>I created this sample or have the rights to submit it for private moderation. No public license is granted.</span></label><p>Confirm rights now for saved revision ${item.revision}; an earlier confirmation does not cover corrected text.</p><button type="submit">${item.state === "changes_requested" ? "Resubmit to private moderation" : "Submit to private moderation"}</button></form>` : ""}${item.rightsAttestedRevision !== null && item.rightsAttestedAt !== null ? `<p>Rights confirmed for revision ${item.rightsAttestedRevision} at <time datetime="${item.rightsAttestedAt.toISOString()}">${item.rightsAttestedAt.toISOString()}</time>.</p>` : ""}${item.state === "quarantined" ? '<p role="status">This proposal is quarantined. Editing and resubmission are unavailable; you can still withdraw it.</p>' : ""}${canWithdraw ? `<form method="post" action="/contribute/${escape(item.id)}/withdraw">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Remove the proposal text and stop moderation.</span></label><button type="submit">Withdraw and redact</button></form>` : ""}<p><a href="/contribute">Your sample proposals</a></p></section>`,
  );
}
type ProposalEditFields = { title: string; body: string; sources: string };
function proposalEditForm(
  id: string,
  csrf: string,
  revision: number,
  value: ProposalEditFields,
) {
  return `<form method="post" action="/contribute/${escape(id)}/edit">${hidden(csrf)}<input type="hidden" name="revision" value="${revision}"><label for="edit-proposal-title">Title</label><input id="edit-proposal-title" name="title" maxlength="160" required value="${escape(value.title)}"><label for="edit-proposal-body">Original sample</label><textarea id="edit-proposal-body" name="body" maxlength="4000" required>${escape(value.body)}</textarea><label for="edit-proposal-sources">Sources and rights notes</label><textarea id="edit-proposal-sources" name="sources" maxlength="1000" required>${escape(value.sources)}</textarea><button type="submit">Save corrections</button></form>`;
}
export function proposalEditRecoveryPage(
  id: string,
  csrf: string,
  message: string,
  attempted: ProposalEditFields,
  revision?: number,
  outcomeUnknown = false,
) {
  const bounded = {
    title: attempted.title.slice(0, 160),
    body: attempted.body.slice(0, 4000),
    sources: attempted.sources.slice(0, 1000),
  };
  const title = outcomeUnknown
    ? "Proposal correction outcome unknown"
    : "Proposal corrections not saved";
  const status = outcomeUnknown
    ? "OUTCOME UNCONFIRMED"
    : "CORRECTIONS NOT SAVED";
  return page(
    title,
    `<section class="error-page"><p class="eyebrow">PRIVATE SAMPLE · ${status}</p><h1>${title}</h1><div class="notice" role="alert"><p>${escape(message)}</p></div>${revision !== undefined ? `<p>You were changing saved revision ${revision}. Check these fields and try again. A changed draft will require you to review the current preview first.</p>${proposalEditForm(id, csrf, revision, bounded)}` : `<p>Copy your attempted text before opening the current preview. This page does not retry the write.</p><label for="unsaved-proposal-title">Attempted title</label><input id="unsaved-proposal-title" readonly value="${escape(bounded.title)}"><label for="unsaved-proposal-body">Attempted sample</label><textarea id="unsaved-proposal-body" readonly>${escape(bounded.body)}</textarea><label for="unsaved-proposal-sources">Attempted sources and rights notes</label><textarea id="unsaved-proposal-sources" readonly>${escape(bounded.sources)}</textarea>`}<p><a href="/contribute/${escape(id)}">Open the current private preview</a> to check the saved revision and submission state.</p></section>`,
  );
}
export function proposalOperationRecoveryPage(
  operation: "creation" | "withdrawal" | "moderation",
  id = "",
) {
  const href =
    operation === "moderation"
      ? "/moderate/proposals"
      : operation === "creation"
        ? "/contribute"
        : `/contribute/${encodeURIComponent(id)}`;
  return page(
    `Proposal ${operation} unconfirmed`,
    `<section class="error-page"><h1>Proposal ${operation} unconfirmed</h1><p role="alert">The operation may already have completed. Nothing is retried automatically.</p><p>${operation === "creation" ? "A draft may already exist. Inspect your private proposals before creating another; repeating creation can make a second draft." : "Inspect the current state before deciding what to do next. An unavailable item does not confirm which action occurred."}</p><p><a href="${escape(href)}">Check current private state</a></p></section>`,
  );
}
export function proposalSubmissionRecoveryPage(id: string) {
  return page(
    "Proposal submission outcome unknown",
    `<section class="error-page"><h1>Proposal submission outcome unknown</h1><p role="alert">Submission could not be confirmed. Inspect the current state and rights revision before trying again. Nothing is retried automatically.</p><p><a href="/contribute/${escape(id)}">Open the current private preview</a></p></section>`,
  );
}
export function proposalChangesRecoveryPage(
  message: string,
  attempted: string,
  outcomeUnknown = false,
) {
  return page(
    outcomeUnknown ? "Change request outcome unknown" : "Changes not requested",
    `<section class="error-page"><h1>${outcomeUnknown ? "Change request outcome unknown" : "Changes not requested"}</h1><p role="alert">${escape(message)}</p><p>Copy your attempted feedback before reopening the private moderation queue. This page does not retry the decision. A missing queue item does not confirm which action occurred.</p><label for="attempted-feedback">Attempted member-visible feedback</label><textarea id="attempted-feedback" readonly>${escape(attempted.slice(0, 1000))}</textarea><p><a href="/moderate/proposals">Open the current moderation queue</a></p></section>`,
  );
}
export function moderationPage(
  items: Proposal[],
  csrf: string,
  now: Date,
  navigation: { nextCursor: string | null; continued: boolean } = {
    nextCursor: null,
    continued: false,
  },
) {
  const entries = items
    .map(
      (item) =>
        `<li data-proposal-id="${escape(item.id)}"><strong>${escape(item.title!)}</strong> · ${escape(item.state)}${item.workflowId ? `<p>Workflow reference: ${escape(item.workflowId)} version ${item.workflowVersion}</p>` : ""}<p>Submitted (UTC): <time datetime="${item.submittedAt!.toISOString()}">${item.submittedAt!.toISOString()}</time> · Elapsed: ${Math.max(0, Math.floor((now.getTime() - item.submittedAt!.getTime()) / 60_000))} minutes</p><p>${escape(item.body!)}</p><p>Sources: ${escape(item.sources!)}</p>${item.state === "submitted" ? `<form method="post" action="/moderate/proposals/${escape(item.id)}/request-changes">${hidden(csrf)}<input type="hidden" name="revision" value="${item.revision}"><p>Reviewing submitted revision ${item.revision}.</p><label for="changes-${escape(item.id)}">Member-visible requested changes (up to 1,000 characters)</label><textarea id="changes-${escape(item.id)}" name="feedback" maxlength="1000" required></textarea><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Send these invented requested changes privately to the proposal owner.</span></label><button type="submit">Request changes</button></form><form method="post" action="/moderate/proposals/${escape(item.id)}/quarantine">${hidden(csrf)}<button type="submit">Quarantine for review</button></form>` : ""}<form method="post" action="/moderate/proposals/${escape(item.id)}/reject">${hidden(csrf)}<button type="submit">Reject and redact</button></form></li>`,
    )
    .join("");
  const empty = items.length
    ? ""
    : navigation.nextCursor
      ? "<p>No eligible proposals remain in this page. Continue to the next page.</p>"
      : navigation.continued
        ? "<p>No later eligible proposals are currently available.</p>"
        : "<p>No submitted proposals await moderation.</p>";
  const next = navigation.nextCursor
    ? `<p>Showing up to 100 proposals. More proposals may be waiting. The next page may be empty if this was the last full page.</p><a href="/moderate/proposals?after=${escape(encodeURIComponent(navigation.nextCursor))}">Next page</a>`
    : items.length === 100 && !navigation.continued
      ? "<p>Showing the first 100 proposals. More proposals may be waiting; return to this queue to check again.</p>"
      : navigation.continued
        ? "<p>End of the current moderation worklist.</p>"
        : "";
  const back = navigation.continued
    ? '<a href="/moderate/proposals">Return to start</a>'
    : "";
  return page(
    "Private proposal moderation",
    `<section class="error-page"><p class="eyebrow">MODERATOR ONLY · NO PUBLICATION</p><h1>Private proposal moderation</h1><p class="lead">Review submitted sample text in quarantine. You can request private changes to a submitted revision, quarantine it, or reject and redact it. Approval and publication are unavailable while licensing policy is pending. This private synthetic worklist has no response-time promise. Elapsed age is as of page load.</p><ul>${entries}</ul>${empty}<nav aria-label="Moderation pages">${next}${back}</nav>${navigation.continued ? "<p>This worklist can change while you browse. Return to start to check earlier submissions.</p>" : ""}</section>`,
  );
}
export function offerHypothesesPage() {
  return page(
    "Access and coaching planning",
    `<section class="error-page"><p class="eyebrow">PLANNING ONLY · NO LIVE PURCHASE</p><h1>Access and coaching planning</h1><p class="lead">The owner approved a no-purchase private/local preview for IT, other professions and general learners using sample information only. Live activation remains disabled; production terms remain undecided, including eligibility, price, limits and AI allowance. No live access or credits are granted here.</p><p>Coaching is optional. These historical prices and allowances are hypotheses, not available offers. A professional background never assigns the Professional coaching package or staff access.</p><ul>${COACHING_OFFERS.map((offer) => `<li><strong>${escape(offer.id)}</strong> · CAD ${(offer.priceCents / 100).toLocaleString("en-CA")} · ${offer.months} monthly periods · ${offer.monthly.coachMinutes} coach / ${offer.monthly.reviewMinutes} review / ${offer.monthly.supportMinutes} support minutes per period · ${escape(offer.termsVersion)} · ${escape(offer.state)}</li>`).join("")}</ul><p>Annual prepayment does not issue future monthly credits. The pilot's internal onboarding reserve is not a purchased member allowance. Qualified capacity, approved terms and a separate production access decision are required before any live service.</p><a class="button" href="/readiness">Integration readiness</a></section>`,
  );
}
function prerequisiteDescription(item: ContentVersion, empty = "None"): string {
  if (
    item.structuredPrerequisites === null ||
    item.structuredPrerequisites === undefined
  )
    return item.prerequisites || empty;
  const spec = effectivePrerequisiteSpec(
    item.structuredPrerequisites,
    item.prerequisites,
  );
  if (!spec) return "Prerequisite unavailable";
  if (spec.all.length === 0) return empty;
  return spec.all
    .map((atom) =>
      atom.kind === "lesson"
        ? `Lesson ${atom.id} version ${atom.version}: ${atom.activity}`
        : `Local exercise ${atom.id} version ${atom.version}: completed`,
    )
    .join("; ");
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
  return `<section class="assignment-options" aria-labelledby="assignment-options-title"><p class="eyebrow">PUBLISHED SAMPLE CONTENT</p><h2 id="assignment-options-title">Choose a practice assignment</h2><p class="small">Suggestions match your current direction and self-reported experience. A completed local exercise can satisfy only the explicitly named local prerequisite; it is not a skill assessment.</p>${selected ? `<p role="status">Your chosen sample: <a href="/library/${encodeURIComponent(selected.id)}">${escape(selected.title)}</a> · version ${selected.version}</p><form method="post" action="/assignments/attempts/start">${hidden(csrf)}<button type="submit">Start or return to this private attempt</button></form>` : choice ? '<p role="status">Your saved choice is no longer available for this direction or published version. Choose another sample below.</p>' : ""}<p><a href="/assignments/attempts">Your private assignment attempts</a></p>${items.length ? `<ul>${items.map((item) => `<li><strong>${escape(item.title)}</strong> · version ${item.version} · ${escape(EXPERIENCE[item.minimumExperience ?? "new"])}<p>${escape(prerequisiteDescription(item, "No prerequisite"))}</p><form method="post" action="/assignments/select">${hidden(csrf)}<input type="hidden" name="content_id" value="${escape(item.id)}"><input type="hidden" name="content_version" value="${item.version}"><button type="submit" class="secondary">Choose ${escape(item.title)}</button> <a href="/library/${encodeURIComponent(item.id)}">Read sample</a></form></li>`).join("")}</ul>` : "<p>No published assignment currently fits your goal, interests, experience and completed prerequisites. Continue with the local foundation lesson or revise your direction.</p>"}</section>`;
}
function assignmentPreparationSection(items: AssignmentReadiness[]) {
  const blocked = items.filter((item) => !item.eligible);
  if (!blocked.length) return "";
  return `<section class="assignment-options" aria-labelledby="assignment-preparation-title"><p class="eyebrow">PRIVATE LOCAL PREPARATION</p><h2 id="assignment-preparation-title">Prepare a future assignment</h2><p>These published sample assignments match your current direction but are not ready to choose. Check the exact prerequisite version and your own activity before starting an attempt.</p><ul>${blocked.map((item) => `<li><strong>${escape(item.title)}</strong> · version ${item.contentVersion}<p><a href="/assignments/readiness/${encodeURIComponent(item.contentId)}?version=${item.contentVersion}">Prepare ${escape(item.title)}</a></p></li>`).join("")}</ul></section>`;
}

function readinessRequirement(item: ReadinessRequirement): string {
  if (item.kind === "unavailable")
    return "<li><strong>Unavailable</strong> · This exact prerequisite is not currently safe to use. Return later or choose another sample; earlier private activity is unchanged.</li>";
  const observed = {
    "not-started": "Not started",
    started: "Started",
    "self-assessed": "Self-assessed",
    completed: "Completed",
    unavailable: "Unavailable",
  }[item.observed];
  const required = item.required
    ? {
        started: "Start this lesson",
        "self-assessed": "Self-assess this lesson after reading",
        completed: "Complete the local foundation exercise",
      }[item.required]
    : "Check this prerequisite";
  const label =
    item.kind === "exercise"
      ? "Local clear-instructions exercise"
      : (item.title ?? "Sample lesson");
  const link =
    !item.satisfied && item.action?.kind === "lesson"
      ? `<p><a href="/library/${encodeURIComponent(item.action.contentId)}?version=${item.action.contentVersion}">Open prerequisite lesson: ${escape(label)}</a></p>`
      : !item.satisfied && item.action?.kind === "exercise"
        ? '<p><a href="/lesson">Complete the local foundation exercise</a></p>'
        : "";
  return `<li><strong>${escape(label)}</strong>${item.contentVersion === undefined ? " · version unavailable" : ` · version ${item.contentVersion}`}<p>Needed: ${required}. Your exact-version activity: <span>${observed}</span>${item.satisfied ? " · requirement met" : " · requirement not yet met"}.</p>${item.detailsLimited ? "<p>Additional prerequisite details are summarized here; this status reflects your saved activity and current eligibility check.</p>" : ""}${link}${item.requirements.length ? `<ul>${item.requirements.map(readinessRequirement).join("")}</ul>` : ""}</li>`;
}

export function assignmentReadinessPage(
  item: AssignmentReadiness,
  csrf: string,
) {
  const status = item.eligible
    ? `<p role="status">The current sample is available to choose. This is based only on the existing local prerequisite checks; it is not a skill assessment.</p><form method="post" action="/assignments/select">${hidden(csrf)}<input type="hidden" name="content_id" value="${escape(item.contentId)}"><input type="hidden" name="content_version" value="${item.contentVersion}"><button type="submit">Choose this sample assignment</button></form>`
    : '<p role="status">This sample is not yet available to choose or start. Complete an available next step, then reload this checklist.</p>';
  return page(
    `Prepare ${item.title}`,
    `<section class="assignment-options assignment-preparation"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SYNTHETIC SAMPLE</p><h1>Prepare ${escape(item.title)}</h1><p>Assignment version ${item.contentVersion}. Your current goal and interests match this sample. Each requirement below names an exact published version; opening this checklist records no progress.</p>${status}<h2>Prerequisite checklist</h2>${item.requirements.length ? `<ul>${item.requirements.map(readinessRequirement).join("")}</ul>` : "<p>No additional local prerequisites are named.</p>"}<p>Starting a lesson and reporting its completion are separate choices. A self-report is not a formal review or proof of competence.</p><p><a href="/learn">Return to your learning path</a></p></section>`,
  );
}
export function assignmentAttemptsPage(items: AssignmentAttemptListItem[]) {
  const rows = items.map((item) => {
    const prior = item.submissionCount ?? 0;
    const state = item.submittedAt
      ? "submitted locally · awaiting future review path"
      : prior > 0
        ? item.savedAt
          ? "private revision draft saved"
          : "private revision started"
        : item.savedAt
          ? "private draft saved"
          : "started only";
    return `<li><a href="/assignments/attempts/${encodeURIComponent(item.id)}">${escape(item.title)}</a> · version ${item.contentVersion} · ${state}${prior ? ` · ${prior} private local submission${prior === 1 ? "" : "s"}` : ""}${item.currentEligible ? "" : " · no longer available for editing"}</li>`;
  });
  return page(
    "Your private assignment attempts",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SAMPLE INFORMATION ONLY</p><h1>Your private assignment attempts</h1><p>Starting, saving, locally submitting and revising are separate states. A local submission is not reviewed work or evidence of competence.</p>${rows.length ? `<ul>${rows.join("")}</ul>` : "<p>No private assignment attempts yet. Choose a published sample from your learning path.</p>"}<p><a href="/learn">Return to your learning path</a></p></section>`,
  );
}
export function assignmentAttemptPage(
  item: AssignmentAttempt,
  csrf: string,
  error = "",
  unsaved?: string,
  conflict = false,
  reflectionDraft?: {
    sequence: number;
    evidence: string;
    gaps: string;
    intention: string;
    conflict?: boolean;
  },
) {
  const url = `/assignments/attempts/${encodeURIComponent(item.id)}`;
  const prior = item.submissionCount ?? 0;
  const editable = item.currentEligible && !item.submittedAt && !conflict;
  const responseView = editable
    ? `<form method="post" action="${url}/save" data-attempt-save>${hidden(csrf)}<input type="hidden" name="revision" value="${item.revision}"><label for="attempt-response">Private sample response</label><textarea id="attempt-response" name="response" maxlength="4000" rows="8">${escape(unsaved ?? item.response)}</textarea><label class="check"><input type="checkbox" name="sample_confirmed" value="yes" required><span>I used only invented or sample information.</span></label><button type="submit">Save private draft</button><p role="status" aria-live="polite" hidden>Saving private draft… Please wait; the result is not confirmed.</p></form>`
    : unsaved !== undefined
      ? `<label for="unsaved-attempt-response">Unsaved response to copy</label><textarea id="unsaved-attempt-response" rows="8" readonly>${escape(unsaved)}</textarea>`
      : `<pre class="content-text">${escape(item.response)}</pre>`;
  const history = item.submissions ?? [];
  const reflectionFields = (
    sequence: number,
    evidence: string,
    gaps: string,
    intention: string,
  ) =>
    `<label for="reflection-evidence-${sequence}">Evidence I can point to</label><textarea id="reflection-evidence-${sequence}" name="evidence" maxlength="1000" rows="3">${escape(evidence)}</textarea><label for="reflection-gaps-${sequence}">Gaps or uncertainty</label><textarea id="reflection-gaps-${sequence}" name="gaps" maxlength="1000" rows="3">${escape(gaps)}</textarea><label for="reflection-intention-${sequence}">What I will change</label><textarea id="reflection-intention-${sequence}" name="intention" maxlength="1000" rows="3">${escape(intention)}</textarea>`;
  const reflectionView = (entry: AssignmentSubmission) => {
    const saved = entry.reflection;
    const deleted = !saved && (entry.reflectionRevision ?? 0) > 0;
    const draft =
      reflectionDraft?.sequence === entry.sequence
        ? reflectionDraft
        : undefined;
    const base = `${url}/reflections/${entry.sequence}`;
    if (deleted)
      return "<p>This private reflection was deleted. Its text is no longer retained.</p>";
    if (draft?.conflict)
      return `<p role="alert">This reflection was not saved. Copy your attempted text and reload the current version before trying again.</p>${reflectionFields(entry.sequence, draft.evidence, draft.gaps, draft.intention)}`;
    const fields = draft ?? saved ?? { evidence: "", gaps: "", intention: "" };
    return `<form method="post" action="${base}/save">${hidden(csrf)}<input type="hidden" name="reflection_revision" value="${entry.reflectionRevision ?? 0}">${reflectionFields(entry.sequence, fields.evidence, fields.gaps, fields.intention)}<label class="check"><input type="checkbox" name="sample_confirmed" value="yes" required><span>This self-reflection contains only invented or sample information.</span></label><button type="submit">Save private reflection for submission ${entry.sequence}</button></form>${saved ? `<form method="post" action="${base}/delete">${hidden(csrf)}<input type="hidden" name="reflection_revision" value="${entry.reflectionRevision ?? 0}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete this reflection without deleting submission ${entry.sequence}</span></label><button class="secondary" type="submit">Delete reflection ${entry.sequence}</button></form>` : ""}`;
  };
  const compareLink =
    history.length >= 2
      ? `<p><a href="${url}/compare?from=${history[0]!.sequence}&amp;to=${history.at(-1)!.sequence}">Compare private submissions</a></p>`
      : "";
  const historyView = history.length
    ? `<section aria-label="Private local submission history"><h2>Private local submission history</h2><ol>${history.map((entry) => `<li id="submission-${entry.sequence}"><strong>Submission ${entry.sequence}</strong> · ${escape(entry.submittedAt)}<pre class="content-text">${escape(entry.response)}</pre><section aria-label="Reflection for submission ${entry.sequence}"><h3>Private self-reflection for submission ${entry.sequence}</h3><p>SELF-REPORTED · SIMULATED · UNREVIEWED. This note does not assess your work or go to a reviewer.</p>${entry.reflection?.intention && entry.sequence === prior && !item.submittedAt ? `<p>Earlier revision intention beside this draft: ${escape(entry.reflection.intention)}</p>` : ""}${reflectionView(entry)}</section><p><a href="${url}/portfolio/${entry.sequence}" download>Download simulated portfolio statement for submission ${entry.sequence}</a></p></li>`).join("")}</ol>${compareLink}<p>These submitted versions and their portfolio statements are simulated, self-authored and unreviewed. Downloads contain only the selected immutable submission; they are not credentials or formal assessments. Deleting this attempt deletes every stored version; it cannot erase files you already downloaded.</p></section>`
    : "";
  const revisionAction =
    item.currentEligible && item.submittedAt && prior < 10 && !conflict
      ? `<form method="post" action="${url}/revise">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Start a new private revision; keep my earlier submitted response unchanged.</span></label><button type="submit">Revise privately</button></form>`
      : prior >= 10 && item.submittedAt
        ? "<p>The ten-submission local preview limit is reached. Your earlier submissions remain private and readable.</p>"
        : "";
  return page(
    "Private assignment attempt",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · NO FORMAL REVIEW</p><h1>${escape(item.title)}</h1><p>Assignment ${escape(item.contentId)} · Assignment version ${item.contentVersion} · goal when started: ${escape(item.goalAtStart)} · ${item.submittedAt ? "submitted locally" : prior > 0 ? (item.savedAt ? "private revision draft saved" : "private revision started") : item.savedAt ? "private draft saved" : "started only"}</p><p>This attempt stays pinned to its original assignment and rubric version. Submitting only records your own saved sample response; it does not send it to a reviewer or assess your skill.</p><section aria-label="Original assignment rubric"><h2>Original rubric</h2>${item.rubric ? `<p>Original rubric version ${item.rubricVersion}</p><pre class="content-text">${escape(item.rubric)}</pre>` : "<p>No rubric was retained for this assignment version. No criteria are inferred.</p>"}</section>${error ? `<div class="notice" role="alert"><p>${escape(error)}</p></div>` : ""}${!item.currentEligible && !item.submittedAt ? "<p>The assignment or your current direction changed. Your earlier work remains private and readable, but this version cannot be edited. Choose an available sample to start again.</p>" : ""}<h2>Your response</h2>${responseView}${conflict ? `<p>${unsaved !== undefined ? "Copy your unsaved text before reloading the saved attempt to reconcile it." : "Reload this attempt to check the current saved state before trying again."}</p>` : ""}${item.currentEligible && item.savedAt && !item.submittedAt && !conflict ? `<form method="post" action="${url}/submit">${hidden(csrf)}<input type="hidden" name="revision" value="${item.revision}"><input type="hidden" name="response_snapshot" value="${escape(item.response)}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Submit this saved version locally; no human review is connected.</span></label><button type="submit">Submit saved version locally</button></form>` : ""}${revisionAction}${historyView}<form method="post" action="${url}/delete">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete this private attempt and all its submissions</span></label><button class="secondary" type="submit">Delete attempt</button></form><p><a href="/assignments/attempts">All private attempts</a> · <a href="/learn">Your learning path</a></p></section>${editable ? '<script type="module" src="/assets/attempt-save.js"></script>' : ""}`,
  );
}
export function assignmentPortfolioStatement(
  item: AssignmentAttempt,
  entry: AssignmentSubmission,
) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated portfolio statement</title></head><body><main><h1>Simulated portfolio statement</h1><p><strong>SIMULATED · SELF-AUTHORED · UNREVIEWED</strong></p><p>Private local learning sample. This is not a credential, qualification, expert assessment or paid review. No reviewer has assessed this response.</p><h2>${escape(item.title)}</h2><p>Assignment: ${escape(item.contentId)} · assignment version ${item.contentVersion}</p><p>Attempt: ${escape(item.id)} · submission ${entry.sequence}</p><p>Submitted locally: ${escape(entry.submittedAt)}</p><h2>Self-authored sample response</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere"><span>${escape(entry.response).replace(/\r/g, "&#13;")}</span></pre><p>This file contains one immutable submitted snapshot, not a current draft. Keep it private. Deleting the source attempt cannot erase a downloaded copy.</p></main></body></html>`;
}

export function assignmentComparisonPage(
  item: AssignmentAttempt,
  from: number,
  to: number,
  comparison: ReturnType<typeof compareResponses>,
) {
  // HTML input-stream newline normalization would otherwise change CR/CRLF
  // snapshot text before a learner can copy it from the rendered page.
  const exactText = (value: string) => escape(value).replace(/\r/g, "&#13;");
  const base = `/assignments/attempts/${encodeURIComponent(item.id)}`;
  const submissions = item.submissions!;
  const first = submissions.find((entry) => entry.sequence === from)!;
  const second = submissions.find((entry) => entry.sequence === to)!;
  const options = (selected: number) =>
    submissions
      .map(
        (entry) =>
          `<option value="${entry.sequence}"${entry.sequence === selected ? " selected" : ""}>Submission ${entry.sequence} · ${escape(entry.submittedAt)}</option>`,
      )
      .join("");
  const changes =
    comparison.kind === "identical"
      ? "<p>No text changed between these two submissions.</p>"
      : `<p>${comparison.kind === "sections" ? "Section comparison: the long responses are shown in full below, while the changed middle is grouped into removed and added sections." : "Line comparison: unchanged, removed and added lines are labelled below."}</p><ol>${comparison.changes.map((change) => `<li><strong>${change.kind === "unchanged" ? "Unchanged" : change.kind === "removed" ? "Removed" : "Added"}</strong><pre class="content-text"><span>${exactText(change.text)}</span></pre></li>`).join("")}</ol>`;
  return page(
    "Compare private submissions",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · NO FORMAL REVIEW</p><h1>Compare private submissions</h1><p>${escape(item.title)} · assignment version ${item.contentVersion}. These are your immutable, unreviewed synthetic submissions. This comparison does not assess your work.</p><form method="get" action="${base}/compare"><fieldset><legend>Choose two submitted versions</legend><label for="compare-from">From submission</label><select id="compare-from" name="from" required>${options(from)}</select><label for="compare-to">To submission</label><select id="compare-to" name="to" required>${options(to)}</select></fieldset><button type="submit">Compare submissions</button></form><section aria-label="Text changes"><h2>Text changes</h2>${changes}</section><section aria-label="Original submissions"><h2>Original submissions</h2><h3>From submission ${first.sequence} · ${escape(first.submittedAt)}</h3><pre class="content-text"><span>${exactText(first.response)}</span></pre><h3>To submission ${second.sequence} · ${escape(second.submittedAt)}</h3><pre class="content-text"><span>${exactText(second.response)}</span></pre></section><p><a href="${base}">Return to this private attempt</a></p></section>`,
  );
}
export function assignmentWriteRecoveryPage(
  title: string,
  message: string,
  response: string,
  id: string,
) {
  return page(
    title,
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · WRITE NOT CONFIRMED</p><h1>${escape(title)}</h1><div class="notice" role="alert"><p>${escape(message)}</p></div>${response ? `<label for="unsaved-attempt-response">Response to copy before leaving this page</label><textarea id="unsaved-attempt-response" rows="8" readonly>${escape(response)}</textarea>` : ""}<p><a href="/assignments/attempts/${encodeURIComponent(id)}">Reload this attempt</a> to check the saved version and submission state before trying again. This page does not send another write.</p><p><a href="/">Start a fresh preview session</a> if yours ended.</p></section>`,
  );
}
export function assignmentReflectionRecoveryPage(
  title: string,
  message: string,
  id: string,
  values: { evidence: string; gaps: string; intention: string },
) {
  return page(
    title,
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · REFLECTION NOT CONFIRMED</p><h1>${escape(title)}</h1><div class="notice" role="alert"><p>${escape(message)}</p></div><p>Copy your attempted self-reflection before leaving this page. No new write is sent by reloading.</p><label for="copy-evidence">Evidence I can point to, to copy</label><textarea id="copy-evidence" rows="3" readonly>${escape(values.evidence)}</textarea><label for="copy-gaps">Gaps or uncertainty, to copy</label><textarea id="copy-gaps" rows="3" readonly>${escape(values.gaps)}</textarea><label for="copy-intention">What I will change, to copy</label><textarea id="copy-intention" rows="3" readonly>${escape(values.intention)}</textarea><p><a href="/assignments/attempts/${encodeURIComponent(id)}">Inspect the current saved attempt</a> before retrying.</p><p><a href="/">Start a fresh preview session</a> if yours ended.</p></section>`,
  );
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
export function welcome(
  csrf: string,
  error: string[] = [],
  onboardingState?: ProfileStartResult,
) {
  const syntheticError = onboardingState?.errors.find(
    (item) => item.field === "synthetic",
  )?.message;
  return page(
    onboardingState?.errors.length
      ? "Error in your onboarding"
      : "A practical start with AI",
    `<section class="hero"><div><p class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</p><h1>Find your place<br>in the future of <em>AI.</em></h1><p class="lead">A little curiosity. A useful skill. Something you can put into practice today.</p><div class="pill-row"><span>No coding required</span><span>Learn at your pace</span><span>Built for different starting points</span></div></div><aside class="path-card"><span class="eyebrow">YOUR FIRST SMALL WIN</span><h2>A clearer instruction.<br>A more useful result.</h2><p>Learn how to give AI context, set a useful task and check its answer.</p><div class="path-step"><b>01</b><span>Choose your direction</span></div><div class="path-step"><b>02</b><span>Learn one practical idea</span></div><div class="path-step"><b>03</b><span>Try it. Check it. Keep it.</span></div><p class="small">12 minutes · One guided exercise</p></aside></section><section class="onboard"><div><p class="eyebrow">MAKE THIS YOUR STARTING POINT</p><h2>What brings you here?</h2><p>Choose an example that feels useful to you, whether you are exploring AI, applying it at work or building something new.</p><p class="small">Your work stays on this computer. This browser can access it for up to 30 days; clearing its cookie loses access. Use Delete this preview to remove your saved work.</p></div><form method="post" action="/start">${hidden(csrf)}${onboardingState ? profileErrorSummary(onboardingState, "Fix your starting choices") : notice(error)}${profileFields(undefined, onboardingState?.attempted, onboardingState?.errors)}<label class="check"><input id="synthetic" type="checkbox" name="synthetic" value="yes" required${onboardingState?.syntheticAcknowledged ? " checked" : ""}${syntheticError ? ' aria-invalid="true" aria-describedby="synthetic-error"' : ""}><span>I'll use invented or sample information in this preview.</span></label>${syntheticError ? `<p id="synthetic-error" class="field-error">${escape(syntheticError)}</p>` : ""}<button type="submit">Start my learning path <span aria-hidden="true">↗</span></button></form></section>`,
  );
}
function usefulnessAction(
  item: ActivityItem,
  reports: UsefulnessReport[],
  csrf: string,
) {
  if (!item.contentId) return "";
  const report = reports.find(
    (entry) =>
      entry.contentId === item.contentId &&
      entry.contentVersion === item.version,
  );
  if (!item.reportable && !report) return "";
  const action = `/library/${encodeURIComponent(item.contentId)}/usefulness`;
  const common = `${hidden(csrf)}<input type="hidden" name="content_version" value="${item.version}"><input type="hidden" name="revision" value="${report?.revision ?? 0}">`;
  return `<section aria-label="Private lesson usefulness"><h3>Was this sample lesson helpful for your next practical step?</h3><p>This is your own report about usefulness, not a skill test or a reviewed outcome. It stays private in this local preview.</p>${report ? `<p role="status">Your current answer: ${report.choice === "helpful" ? "Helpful for my next step" : "Not helpful yet"} · updated ${escape(report.updatedAt.toISOString().slice(0, 16))} UTC.</p>` : ""}${item.reportable ? `<form method="post" action="${action}">${common}<label for="usefulness-${escape(item.contentId)}-${item.version}">Your answer</label><select id="usefulness-${escape(item.contentId)}-${item.version}" name="choice" required><option value="">Choose an answer</option><option value="helpful"${report?.choice === "helpful" ? " selected" : ""}>Helpful for my next step</option><option value="not_yet"${report?.choice === "not_yet" ? " selected" : ""}>Not helpful yet</option></select><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>This is my own response about sample learning, with no private client information.</span></label><button type="submit" name="intent" value="save">${report ? "Correct my usefulness answer" : "Save my usefulness answer"}</button></form>` : "<p>This historical version cannot receive a new or corrected answer.</p>"}${report ? `<form method="post" action="${action}">${common}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw this private answer</span></label><button class="secondary" type="submit" name="intent" value="withdraw">Withdraw my usefulness answer</button></form>` : ""}</section>`;
}
export function privateProgressPage(
  items: ActivityItem[],
  reports: UsefulnessReport[] = [],
  csrf = "",
) {
  return page(
    "Your private learning activity",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SYNTHETIC WORK</p><h1>Your private learning activity</h1><p>Opening a lesson, saving a draft, reporting completion and submitting an assignment are different actions. None is a qualified assessment or proof of skill.</p>${
      items.length
        ? `<ol>${items
            .map(
              (item) =>
                `<li><h2>${escape(item.title)}</h2><p>${escape(item.kind)} · version ${item.version} · ${escape(item.state)}${item.submittedAt ? ` · ${escape(item.submittedAt)}` : ""}</p><p>${escape(item.availability)}</p>${item.href ? `<a href="${escape(item.href)}">Open this private activity</a>` : "<span>No current content link for this version.</span>"}${usefulnessAction(item, reports, csrf)}</li>`,
            )
            .join("")}</ol>`
        : '<p>No learning activity has been saved in this preview yet. <a href="/learn">Open your starter plan</a> to begin with a sample lesson.</p>'
    }<p><a href="/learn">Return to your learning path</a></p></section>`,
  );
}
function profileErrorSummary(
  edit: ProfileEditResult,
  heading = "Fix your profile before saving",
) {
  return `<div class="notice" role="alert"><h3>${escape(heading)}</h3><p>Your changes were not saved. Correct the marked fields, then save again.</p><ul>${edit.errors.map((error) => `<li><a href="#${error.field}">${escape(error.message)}</a></li>`).join("")}</ul></div>`;
}
export function dashboard(
  learner: Learner,
  progress: Exercise | undefined,
  csrf: string,
  errors: string[] = [],
  assignments: ContentVersion[] = [],
  choice: AssignmentChoice | null = null,
  recommendedLesson: ContentVersion | null = null,
  profileState?: ProfileEditResult,
  readiness: AssignmentReadiness[] = [],
) {
  if (
    progress?.goal_at_start !== undefined &&
    progress.goal_at_start !== learner.goal
  )
    progress = undefined;
  const done = Boolean(progress?.completed_at);
  const status = done
    ? "Completed · self-assessed"
    : progress
      ? "Draft saved"
      : "Ready when you are";
  const plan = learningPlan(learner, progress);
  const time = learner.weeklyMinutes
    ? WEEKLY_TIME[learner.weeklyMinutes as keyof typeof WEEKLY_TIME]
    : undefined;
  const nextLesson = recommendedLesson
    ? `<p><strong>Optional published sample lesson:</strong> ${escape(recommendedLesson.title)} · version ${recommendedLesson.version}. <a href="/library/${encodeURIComponent(recommendedLesson.id)}">Open current sample lesson</a>.</p><p class="small">This catalog sample has no scheduled duration or qualified curriculum sign-off. Opening it records activity; it does not assess your skill.</p>`
    : '<p role="status">No additional published sample lesson currently fits your direction and completed prerequisites. Your starter lesson remains available.</p>';
  return page(
    profileState?.errors.length
      ? "Error in your profile"
      : "Your learning path",
    `<section class="dashboard-head"><div><p class="eyebrow">YOUR LEARNING SPACE</p><h1>Small steps.<br><em>Useful skills.</em></h1><p class="lead">${GOALS[learner.goal]}</p><span class="subtle-tag">${BACKGROUNDS[learner.background]}</span></div><aside class="progress-card"><p class="eyebrow">YOUR PROGRESS</p><strong>${done ? "1" : "0"}<small> / 1</small></strong><p>exercise completed</p><progress aria-label="Exercises completed" value="${done ? 1 : 0}" max="1"></progress><span class="small">Completion records your own practice, not a formal assessment.</span></aside></section><section class="learning-plan" aria-labelledby="learning-plan-title"><p class="eyebrow">PRIVATE FOUNDATION PREVIEW</p><h2 id="learning-plan-title">Your starter plan</h2><p>Focus: ${escape(plan.focus)}. ${escape(plan.guidance)}</p><p class="small">Weekly time: ${escape(time ?? "Not specified")} · Time zone: ${escape(learner.timezone ?? "Not specified")} · AI experience: self-reported ${escape(learner.experience ? EXPERIENCE[learner.experience] : "Not specified")}</p>${plan.status ? `<p role="status">${escape(plan.status)}</p>` : ""}${plan.steps.length ? `<ol>${plan.steps.map((step) => `<li>${step.minutes} minutes · ${escape(step.action)}</li>`).join("")}</ol>` : ""}${plan.nextSession ? `<p>${escape(plan.nextSession)}${plan.nextHref ? ` <a href="${plan.nextHref}">${escape(plan.nextLinkLabel!)}</a>` : ""}</p>` : ""}${plan.exploratory ? `<p>${escape(plan.exploratory)}</p>` : ""}<p class="small">${plan.status ? "Your completed starter exercise remains private and self-assessed." : "The timed steps use only the local starter lesson. Revisit or skip steps you already completed."} These suggestions do not book coaching or certify a skill.</p><section aria-label="Suggested next sample lesson"><h3>Explore another sample lesson</h3>${nextLesson}</section></section>${assignmentSection(assignments, choice, csrf)}${assignmentPreparationSection(readiness)}<section class="learning-grid"><article class="lesson-card"><p class="eyebrow">FOUNDATION · LESSON 01</p><span class="status">${status}</span><h2>${LESSON.title}</h2><p>Context. A clear task. A way to check the answer. Three things that make a better starting point.</p><p class="small">${LESSON.minutes} minutes · No coding · Version ${LESSON.version}</p><a class="button" href="/lesson">${done ? (progress?.withdrawn_at ? "View completion" : "Review your work") : progress ? "Continue exercise" : "Open lesson"} <span aria-hidden="true">↗</span></a></article><aside class="next-card"><p class="eyebrow">WHERE THIS CAN GO</p><h2>Learn together.<br>Contribute something useful.</h2><p>Learning circles, peer contributions and more paths are on the roadmap. This preview begins with your first practical exercise.</p><p class="small">Community and coaching features are not yet available.</p></aside></section><p><a class="button secondary" href="/library">Browse published learning library</a> <a class="button secondary" href="/milestones">Plan goals and milestones</a> <a class="button secondary" href="/career">Explore optional career planning</a> <a class="button secondary" href="/contribute">Draft a private sample contribution</a> <a class="button secondary" href="/evidence">Manage private evidence</a> <a class="button secondary" href="/progress">View private learning activity</a> <a class="button secondary" href="/tailored-review">Check tailored-review availability</a> <a class="button secondary" href="/availability">View sample appointment windows</a> <a class="button secondary" href="/events">Explore local events</a> <a class="button secondary" href="/support">Private sample support</a></p><p><a href="/member/export">Download my structured preview records</a>. This versioned JSON includes current profile, learning, plans and retained proposal records. Evidence samples use a separate download. Download bounded live pages of up to 100 records and 256 KiB each. The export excludes audit, billing, derivatives, provider and backup copies.</p><section class="profile-form"><h2>Adjust your direction</h2><p>Change goals and interests whenever you want. Your saved exercise stays with this preview.</p><form method="post" action="/profile">${hidden(csrf)}${profileState ? profileErrorSummary(profileState) : notice(errors)}${profileFields(learner, profileState?.attempted, profileState?.errors)}<button type="submit">Save my direction</button></form></section><form class="delete-form" method="post" action="/delete">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete my local preview and all its saved work.</span></label><button class="secondary" type="submit">Delete this preview</button></form>`,
  );
}
function evidenceLineage(item: OwnedEvidence) {
  if (item.revisionNumber === 1) return " · original";
  if (!item.revisionParentId)
    return " · prior version deleted · parent ID unavailable";
  if (item.revisionParentStatus === "deleting")
    return ` · prior version deletion pending · revises ${escape(item.revisionParentId)}`;
  if (item.revisionParentStatus === "deleted")
    return ` · prior version deleted · revises ${escape(item.revisionParentId)}`;
  return ` · revises ${escape(item.revisionParentId)}`;
}

export function evidencePage(
  items: OwnedEvidence[],
  csrf: string,
  errors: string[] = [],
  attempted: { name: string; sample: string } = { name: "", sample: "" },
) {
  const safety: Record<OwnedEvidence["quarantineState"], string> = {
    pending: "Pending safety check; no live scanner is connected",
    clean: "Safety check passed in this local preview",
    rejected: "Rejected by safety check",
    infected: "Blocked by safety check",
  };
  const submission = {
    queued: "Submitted locally; no qualified review is connected",
    reviewed: "Synthetic review state recorded; no qualification is claimed",
    withdrawn: "Review submission withdrawn",
  };
  return page(
    "Your private evidence",
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a></nav><section class="reading private-evidence"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SAMPLE INFORMATION ONLY</p><h1>Your private evidence</h1><p>Save an invented text sample and control its private-review consent. A new sample stays pending until a safety check runs; no live scanner or qualified reviewer is connected. Do not upload personal, client or confidential material.</p><p><a href="/evidence/local-ai">Choose an invented sample for local AI simulation</a></p>${notice(errors)}<h2>Saved samples</h2>${
      items.length
        ? `<ul>${items
            .map((item) => {
              const path = `/evidence/${encodeURIComponent(item.id)}`;
              return `<li><h3>${escape(item.name)}</h3><p>Private evidence version ${item.revisionNumber}${evidenceLineage(item)} · ${escape(item.id)}</p><p>${escape(safety[item.quarantineState])} · ${item.privateReviewAllowed ? "Private-review consent active" : "Private-review consent revoked"} · ${item.submissionStatus ? escape(submission[item.submissionStatus]) : "Not submitted for review"}</p>${item.quarantineState === "clean" ? `<form method="post" action="${path}/download">${hidden(csrf)}<button type="submit">Download ${escape(item.name)}</button></form>` : ""}${item.quarantineState === "clean" && item.privateReviewAllowed && item.submissionStatus === null ? `<form method="post" action="${path}/queue">${hidden(csrf)}<label class="check"><input type="checkbox" name="acknowledge" value="yes" required><span>No qualified reviewer is assigned. This only records my intent for possible private review in this local preview; no review or response time is promised.</span></label><button class="secondary" type="submit">Queue for local review consideration</button></form>` : ""}${item.mediaType === "text/plain" && item.submissionStatus ? `<p><a href="${path}/feedback">Read private feedback for ${escape(item.name)}</a></p>` : ""}${item.mediaType === "text/plain" && item.quarantineState === "clean" && item.privateReviewAllowed && ["queued", "reviewed"].includes(item.submissionStatus ?? "") && !item.hasRevision && item.revisionNumber < 20 ? `<p><a href="${path}/revise">Create a new private revision of ${escape(item.name)}</a></p>` : ""}${item.privateReviewAllowed ? `<form method="post" action="${path}/revoke-private-review">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Stop private-review access to ${escape(item.name)}</span></label><button class="secondary" type="submit">Revoke review consent</button></form>` : ""}<form method="post" action="${path}/delete">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Delete ${escape(item.name)} and its configured active derivatives</span></label><button class="secondary" type="submit">Delete sample</button></form></li>`;
            })
            .join("")}</ul>`
        : "<p>No sample evidence saved yet. Add an invented text sample below.</p>"
    }<h2>Export these preview samples</h2><p><a href="/evidence/export">Download my evidence JSON</a>. This includes current sample metadata and clean source bytes encoded as base64. Pending or blocked sample bytes, derivatives, assignments, milestones, career plans, billing and hosted copies are not included. Download every live page to collect the available samples. Each page contains at most 20 samples and 4 MiB of raw clean source data. These pages are not a frozen snapshot; start again if samples change.</p><h2>New private text sample</h2><form method="post" action="/evidence">${hidden(csrf)}<label for="evidence-name">Sample title</label><input id="evidence-name" name="name" maxlength="200" required value="${escape(attempted.name)}"><label for="evidence-sample">Invented text sample</label><textarea id="evidence-sample" name="sample" maxlength="4000" required>${escape(attempted.sample)}</textarea><label class="check"><input type="checkbox" name="rights_confirmed" value="yes" required><span>I created this invented sample and have the right to store it.</span></label><label class="check"><input type="checkbox" name="private_review_consent" value="yes" required><span>I explicitly allow this sample to be considered for private review if a safety check and authorized reviewer are later configured. I can revoke this consent.</span></label><button type="submit">Save private text sample</button></form></section>`,
  );
}
export function localAiControlPage(paused: boolean, csrf: string) {
  return page(
    "Local AI simulation control",
    `<section class="reading"><p class="eyebrow">PLATFORM ADMIN · LOCAL SIMULATION ONLY</p><h1>Local AI simulation control</h1><p role="status">Local simulation is ${paused ? "paused" : "available"}.</p><p>This switch affects only deterministic local demo/test requests. It grants no permission, credits, provider access or paid service. A local attempt already running may complete before a pause takes effect.</p><form method="post" action="/operator/local-ai">${hidden(csrf)}<input type="hidden" name="state" value="${paused ? "enabled" : "paused"}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Confirm ${paused ? "resume" : "pause"} for local simulation only</span></label><button type="submit">${paused ? "Resume" : "Pause"} local simulation</button></form></section>`,
  );
}
export function localAiConsentPage(
  choices: LocalAiChoice[],
  csrf: string,
  errors: string[] = [],
  state: "paused" | "enabled" | "unavailable" = "enabled",
) {
  const status = (value: string) =>
    value === "succeeded"
      ? "Simulated locally. No provider request or qualified review occurred."
      : value === "pending"
        ? "Queued only in this local preview"
        : value === "running" || value === "needs_reconciliation"
          ? "Outcome needs local reconciliation; it will not be retried automatically"
          : "Local simulation unavailable or failed";
  const stateNotice =
    state === "paused"
      ? '<p role="status">Local simulations are paused. You can still withdraw permission.</p>'
      : state === "unavailable"
        ? '<p role="status">Local simulations are unavailable. You can still withdraw permission.</p>'
        : "";
  return page(
    "Local AI simulation permission",
    `<nav class="breadcrumb"><a href="/evidence">← Your private evidence</a></nav><section class="reading"><p class="eyebrow">PRIVATE LOCAL SIMULATION · INVENTED TEXT ONLY</p><h1>Choose exactly what this preview may use</h1><p>This local prototype can use one clean version of your invented text sample for a deterministic AI simulation. It makes no network request to an AI provider, gives no qualified feedback, and does not establish production consent. Review or circle permission does not enable it. Do not put personal, client or confidential information here.</p><p>The original local simulation uses no test unit. You can separately choose to hold one already seeded study request for a local test request; completion consumes it once. A cancelled never-started request releases its unit subject to expiry. An uncertain started outcome stays held and will not retry automatically. No money or token estimate is involved. <a href="/member/test-units">See your local test units</a>.</p>${stateNotice}${notice(errors)}${choices.length ? `<ul>${choices.map((choice) => `<li><h2>${escape(choice.name)}</h2><p>Private version ${choice.revisionNumber} · ${escape(choice.evidenceId)}</p>${choice.receiptId ? `<p role="status">Local simulation permission granted for this exact version.</p>${state === "enabled" ? `<form method="post" action="/evidence/local-ai/${encodeURIComponent(choice.receiptId)}/queue">${hidden(csrf)}<button type="submit">Queue local simulation</button></form><form method="post" action="/evidence/local-ai/${encodeURIComponent(choice.receiptId)}/queue-metered">${hidden(csrf)}<input type="hidden" name="key" value="${randomUUID()}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Hold one existing local test request for ${escape(choice.name)}</span></label><button type="submit">Use one local test request</button></form>` : ""}<form method="post" action="/evidence/local-ai/${encodeURIComponent(choice.receiptId)}/withdraw">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw local AI permission for ${escape(choice.name)}</span></label><button class="secondary" type="submit">Withdraw permission</button></form>` : `${choice.withdrawnAt ? '<p role="status">Local AI permission withdrawn. Future simulations need a new grant.</p>' : ""}<form method="post" action="/evidence/local-ai/${encodeURIComponent(choice.evidenceId)}/grant">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I permit this exact invented sample version to be used for local deterministic AI simulation. I can withdraw permission before it runs. No external AI provider is connected.</span></label><button type="submit">Grant local simulation permission</button></form>`}${choice.jobs.length ? `<h3>Local jobs</h3><ul>${choice.jobs.map((job) => `<li><p>${escape(status(job.status))}</p>${job.testUnitState ? `<p role="status">One local test request: ${job.testUnitState === "reserved" ? "held" : job.testUnitState === "consumed" ? "consumed" : "released subject to expiry"}.</p>` : ""}${job.status === "pending" && state === "enabled" ? `<form method="post" action="/evidence/local-ai/${encodeURIComponent(job.id)}/run">${hidden(csrf)}<button type="submit">${job.testUnitState ? "Run local test request" : "Run local simulation"}</button></form>` : ""}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>` : "<p>No clean current invented text sample is available. Save a sample, then complete its local safety check.</p>"}</section>`,
  );
}
export function evidenceRevisionPage(
  parent: OwnedEvidence,
  csrf: string,
  errors: string[] = [],
  attempted: { name: string; sample: string } = { name: "", sample: "" },
) {
  return page(
    "New private evidence revision",
    `<nav class="breadcrumb"><a href="/evidence">← Your private evidence</a></nav><section class="reading"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SAMPLE INFORMATION ONLY</p><h1>New private evidence revision</h1><p>Revising ${escape(parent.name)} · version ${parent.revisionNumber} · ${escape(parent.id)}. The original submission and bytes stay unchanged. This new text receives its own ID and safety check; it is not submitted or assessed automatically.</p>${notice(errors)}<form method="post" action="/evidence/${encodeURIComponent(parent.id)}/revise">${hidden(csrf)}<label for="revision-name">Revised sample title</label><input id="revision-name" name="name" maxlength="200" required value="${escape(attempted.name)}"><label for="revision-sample">New invented text</label><textarea id="revision-sample" name="sample" maxlength="4000" required>${escape(attempted.sample)}</textarea><label class="check"><input type="checkbox" name="rights_confirmed" value="yes" required><span>I created this new invented text and have the right to store it.</span></label><label class="check"><input type="checkbox" name="private_review_consent" value="yes" required><span>I separately allow this revision to be considered for private review after a safety check. No prior reviewer access is copied.</span></label><button type="submit">Save new private revision</button></form></section>`,
  );
}
export function lesson(
  learner: Learner,
  progress: Exercise | undefined,
  csrf: string,
  errors: SubmissionError[] = [],
  history: ExerciseHistory[] = [],
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
  const withdrawal = (version: number, goal = learner.goal as string) =>
    starterWithdrawal(csrf, version, goal);
  const historical = history
    .filter(
      (row) =>
        row.lessonId === LESSON.id &&
        (row.version !== LESSON.version || row.goalAtStart !== learner.goal),
    )
    .map(
      (row) =>
        `<li id="starter-version-${row.version}-${row.goalAtStart ?? "unattributed"}"><h3>Earlier starter exercise · version ${row.version}</h3>${starterRecord(row, csrf)}</li>`,
    )
    .join("");
  return page(
    errors.length ? "Error in your exercise" : LESSON.title,
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a><span>FOUNDATION / 01</span></nav><section class="lesson-heading"><p class="eyebrow">${LESSON.minutes} MINUTES · VERSION ${LESSON.version}</p><h1>${LESSON.title}</h1><p class="lead">AI can produce a confident answer to an unclear question. Give it something concrete to work with—and decide how you'll check the result.</p>${progress?.goal_at_start && progress.goal_at_start !== learner.goal ? '<p class="small">This saved practice remains tied to your earlier goal. Your current direction is shown on your learning path.</p>' : ""}</section><div class="lesson-layout"><article class="reading"><section><span class="number">01</span><h2>Give it context</h2><p>Explain the situation using information you have permission to share. Use sample details when practising. Leave out names, secrets and private client information.</p></section><section><span class="number">02</span><h2>Ask for a useful outcome</h2><p>Name the task, audience and format. Set limits such as length, time or available resources. Ask it to identify missing information instead of guessing.</p></section><section><span class="number">03</span><h2>Decide how you'll check</h2><p>Compare facts against your original material or a reliable source. Check whether the answer fits the task. An AI suggestion is a starting point; you remain responsible for how you use it.</p></section><aside class="example"><p class="eyebrow">A CHECK FOR YOUR EXERCISE</p><p>${prompt.check}</p></aside></article><section id="starter-version-${LESSON.version}" class="exercise-card" aria-labelledby="exercise-title"><p class="eyebrow">PUT IT INTO PRACTICE</p><h2 id="exercise-title">${prompt.title}</h2><p>${prompt.brief}</p>${summary}${done ? `<div class="success" role="status"><strong>Exercise completed</strong><p>Self-assessed practice saved. No AI or qualified reviewer has assessed it.</p></div>${progress!.withdrawn_at ? '<p role="status">Saved exercise text withdrawn. Your text-free self-reported completion, date and version remain.</p>' : `<h3>Your instruction</h3><p class="saved-answer">${escape(progress!.instruction!)}</p><h3>Your way to check</h3><p class="saved-answer">${escape(progress!.verification!)}</p>${withdrawal(LESSON.version)}`}<a class="button" href="/learn">See your progress</a>` : `<form method="post" action="/exercise">${hidden(csrf)}<input type="hidden" name="lesson_id" value="${escape(LESSON.id)}"><input type="hidden" name="lesson_version" value="${LESSON.version}"><input type="hidden" name="goal" value="${learner.goal}"><label for="instruction">Your instruction to AI</label><textarea id="instruction" name="instruction" maxlength="2000" rows="5" aria-describedby="answer-help${instructionError ? " instruction-error" : ""}"${instructionError ? ' aria-invalid="true"' : ""}>${escape(progress?.instruction ?? "")}</textarea><p id="answer-help" class="small">Use at least 20 characters to complete. You can save an unfinished draft.</p>${instructionError ? `<p id="instruction-error" class="field-error">${escape(instructionError)}</p>` : ""}<label for="verification">How will you check the result?</label><textarea id="verification" name="verification" maxlength="1000" rows="3" aria-describedby="verification-help${verificationError ? " verification-error" : ""}"${verificationError ? ' aria-invalid="true"' : ""}>${escape(progress?.verification ?? "")}</textarea><p id="verification-help" class="small">Use at least 20 characters to complete. You can save an unfinished draft.</p>${verificationError ? `<p id="verification-error" class="field-error">${escape(verificationError)}</p>` : ""}<label class="check"><input id="checked" type="checkbox" name="checked" value="yes"${checkedError ? ' aria-invalid="true" aria-describedby="checked-error"' : ""}><span>I checked the context, task and verification plan, and used only sample information.</span></label>${checkedError ? `<p id="checked-error" class="field-error">${escape(checkedError)}</p>` : ""}<div class="actions"><button type="submit" name="intent" value="complete">Complete exercise</button><button type="submit" name="intent" value="draft" class="secondary">Save draft</button></div>${progress && !errors.length ? '<p class="saved-note" role="status">Your draft is saved. You can return in this browser.</p>' : ""}</form>`}</section></div>${historical ? `<section class="reading" aria-label="Retained starter exercises"><h2>Retained starter exercises</h2><ol>${historical}</ol></section>` : ""}<p class="small">Withdrawal removes the saved text from this local preview. It does not recall previously downloaded copies or prove erasure from hosted backups.</p>`,
  );
}
function starterWithdrawal(csrf: string, version: number, goal: string) {
  return `<form method="post" action="/exercise/${escape(LESSON.id)}/${version}/withdraw">${hidden(csrf)}<input type="hidden" name="goal" value="${escape(goal)}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw both saved text fields for version ${version}. Keep my text-free self-reported completion, date and version.</span></label><button class="secondary" type="submit">Withdraw completed exercise text</button></form>`;
}
function starterRecord(row: ExerciseHistory, csrf: string) {
  const goal = row.goalAtStart;
  return `<p>Recorded goal: ${goal ? escape(GOALS[goal]) : "Unattributed historical goal"}.</p>${row.completedAt ? `<p>Self-reported complete on ${escape(row.completedAt.toISOString())}.</p>` : "<p>Draft saved; not completed.</p>"}${row.withdrawnAt ? '<p role="status">Saved exercise text withdrawn. Your self-reported completion remains.</p>' : `<h4>Your instruction</h4><p class="saved-answer">${escape(row.instruction ?? "")}</p><h4>Your way to check</h4><p class="saved-answer">${escape(row.verification ?? "")}</p>${row.completedAt ? starterWithdrawal(csrf, row.version, goal ?? "unattributed") : ""}`}`;
}
export function starterRecordPage(row: ExerciseHistory, csrf: string) {
  const guidance =
    !row.completedAt &&
    row.version === LESSON.version &&
    row.goalAtStart !== null
      ? "To continue this draft, choose its recorded goal on your learning path and open the current lesson."
      : "This retained record is read-only. Open your current goal's lesson for current practice.";
  return page(
    "Saved starter practice",
    `<section class="reading" id="starter-version-${row.version}-${row.goalAtStart ?? "unattributed"}"><h1>Saved starter practice · version ${row.version}</h1>${starterRecord(row, csrf)}<p>This is the exact saved record. ${guidance}</p><a href="/progress">Return to private activity</a> <a href="/lesson">Open your current goal's lesson</a></section>`,
  );
}
export function exerciseWriteRecoveryPage(
  instruction: string,
  verification: string,
  goal?: string,
) {
  return page(
    "Save outcome unknown",
    `<section class="error-page"><p class="eyebrow">PRIVATE LOCAL RECOVERY</p><h1>Save outcome unknown</h1><div class="notice" role="alert"><p>The storage result could not be confirmed. Your exercise may or may not have been saved. Copy the attempted text below before closing this page, then inspect the saved lesson before deciding whether to try again. Nothing will be submitted automatically.</p></div><label for="attempted-instruction">Attempted instruction</label><textarea id="attempted-instruction" rows="5" readonly>${escape(instruction)}</textarea><label for="attempted-verification">Attempted way to check</label><textarea id="attempted-verification" rows="3" readonly>${escape(verification)}</textarea><p><a class="button" href="${goal ? `/lesson?version=${LESSON.version}&amp;goal=${escape(goal)}` : "/lesson"}" target="_blank" rel="noopener noreferrer">Inspect saved lesson (opens in a new tab)</a></p><p class="small">The new tab shows the current saved state. Keep this recovery page open until you have copied anything you need.</p></section>`,
  );
}
export function circleMembershipRecoveryPage() {
  return page(
    "Circle membership unconfirmed",
    `<section class="error-page"><h1>Circle membership unconfirmed</h1><p>The request may already have completed. Nothing is retried automatically.</p><p>Check your current membership before choosing to join or leave again.</p><p><a href="/circles">Check current membership</a></p></section>`,
  );
}

export function errorPage(title: string, message: string) {
  return page(
    title,
    `<section class="error-page"><p class="eyebrow">A SMALL PAUSE</p><h1>${escape(title)}</h1><p class="lead">${escape(message)}</p><a class="button" href="/learn">Return to your learning path</a></section>`,
  );
}
export function circlesPage(
  items: CircleListing[],
  goal: keyof typeof GOALS,
  csrf: string,
  discussionEnabled = false,
) {
  return page(
    "Local learning circles",
    `<section class="lesson-heading"><p class="eyebrow">PRIVATE LOCAL PREVIEW · NO LIVE COMMUNITY</p><h1>Explore learning circles</h1><p class="lead">Join a small, invented topic space to try the membership controls. ${discussionEnabled ? "Invented discussion is available only after a separate circle sharing choice. No staffed moderation, clinic, expert or recording is available." : "New discussion sharing is paused. No clinic, expert, recording or shared member evidence is enabled."} Your name and private learning work are not shown to other members.</p><p>Joining is optional and grants no paid service or staff role. You can leave at any time; only your own membership state and aggregate seats appear here.</p></section><section aria-label="Available circles"><ul>${items.map((item) => `<li><h2>${escape(item.title)}</h2><p>${escape(item.description)}</p><p>${item.goal === goal ? "Matches your current goal" : "Open to explore"} · ${escape(GOALS[item.goal])} · ${item.seatsRemaining} of ${item.capacity} seats available</p>${item.joined ? `<p role="status">You joined this local circle.</p>${discussionEnabled ? `<p><a href="/circles/${escape(item.id)}/discussion/choice">Choose invented discussion sharing</a> · <a href="/circles/${escape(item.id)}/discussion">Read circle questions</a></p>` : ""}<p><a href="/circles/${escape(item.id)}/discussion/owned">Your retained circle contributions</a></p><form method="post" action="/circles/${escape(item.id)}/leave">${hidden(csrf)}<button class="secondary" type="submit">Leave ${escape(item.title)}</button></form>` : item.seatsRemaining > 0 ? `<form method="post" action="/circles/${escape(item.id)}/join">${hidden(csrf)}<button type="submit">Join ${escape(item.title)}</button></form>` : '<p role="status">This local circle is full.</p>'}</li>`).join("")}</ul></section><p><a href="/learn">Return to your learning path</a></p>`,
  );
}
function previewEventTime(event: EventPreview, timezone?: string | null) {
  const utc = `UTC ${event.startsAt} to ${event.endsAt}`;
  const localStart = timezone
    ? localSlotTime(new Date(event.startsAt), timezone)
    : null;
  const localEnd = timezone
    ? localSlotTime(new Date(event.endsAt), timezone)
    : null;
  return `<p>Sample schedule: <time datetime="${escape(event.startsAt)}">${escape(utc)}</time>.</p>${localStart && localEnd ? `<p>In your saved time zone, ${escape(timezone!)}: ${escape(localStart)} to ${escape(localEnd)}.</p>` : '<p>Your local time is unavailable. <a href="/learn#timezone">Set your time zone</a> in your profile to see it.</p>'}`;
}

export function eventDiscoveryPage(
  items: EventPreview[],
  timezone?: string | null,
  allTopics = false,
  registrationEnabled = false,
) {
  const intro = allTopics
    ? "Exploring all topics"
    : "Events matched to your saved goal or interests";
  const list = items.length
    ? `<ul>${items.map((event) => `<li><h2><a href="/events/${encodeURIComponent(event.id)}/${event.version}">${escape(event.title)}</a></h2><p>${escape(event.description)}</p><p>Version ${event.version} · ${registrationEnabled && event.localRegistration ? "Synthetic preview; local registration rehearsal only" : "Synthetic preview; enrollment unavailable"}</p>${previewEventTime(event, timezone)}${registrationEnabled && event.localRegistration ? `<p><a href="/events/${encodeURIComponent(event.id)}/${event.version}/rehearsal">Try local registration rehearsal</a></p>` : ""}</li>`).join("")}</ul>`
    : `<p role="status">${allTopics ? "No upcoming synthetic event previews are available." : "No upcoming synthetic event previews match your saved goal or interests."} Nothing has been booked or reserved.</p>`;
  return page(
    "Sample events",
    `<nav class="breadcrumb"><a href="/learn">← Your learning path</a></nav><section class="reading"><p class="eyebrow">SYNTHETIC, UNREVIEWED LOCAL PREVIEWS</p><h1>Explore sample events</h1><p>No real clinic, qualified expert, recording or live community is available here. ${registrationEnabled ? "Explicitly labelled local registration rehearsals use invented data only." : "Enrollment is unavailable."} Sample times and fixture capacity are not available seats.</p><p>Access and cost: unresolved. Expert coverage: unresolved. Recording: unresolved.</p><p role="status">${intro}</p><p>${allTopics ? '<a href="/events">Show matches for my direction</a>' : '<a href="/events?all=1">Explore other topics</a>'}</p>${list}<p><a href="/events/registrations">Your registration history</a></p></section>`,
  );
}

export function eventDetailPage(
  detail: Exclude<EventPreviewDetail, { status: "missing" }>,
  timezone?: string | null,
  registrationEnabled = false,
) {
  const event = detail.event;
  const current = detail.status === "current";
  const unavailable = {
    past: "This event has already started",
    retired: "This event version was retired",
    replaced: "This event version was replaced",
  } as const;
  const agenda = current
    ? `<h2>Sample agenda</h2><ol>${event.agenda.map((item) => `<li>${escape(item)}</li>`).join("")}</ol>`
    : `<p role="status">${unavailable[detail.status as keyof typeof unavailable]}. This exact version is unavailable; nothing was booked. Browse current previews separately.</p>`;
  return page(
    event.title,
    `<nav class="breadcrumb"><a href="/events">← Sample events</a></nav><article class="reading"><p class="eyebrow">SYNTHETIC, UNREVIEWED LOCAL PREVIEW</p><h1>${escape(event.title)}</h1><p>Version ${event.version} · ${registrationEnabled && event.localRegistration ? "Synthetic preview; local registration rehearsal only" : "Synthetic preview; enrollment unavailable"}</p><p>${escape(event.description)}</p>${current ? previewEventTime(event, timezone) : ""}${agenda}${registrationEnabled && event.localRegistration ? `<p><a href="/events/${encodeURIComponent(event.id)}/${event.version}/rehearsal">Try local registration rehearsal</a></p>` : ""}<h2>Readiness</h2><p>Access and cost: unresolved</p><p>Expert coverage: unresolved</p><p>Recording: unresolved</p><p>No live clinic or reservation exists. A sample fixture capacity is not remaining seats.</p></article>`,
  );
}
export function workflowRegistryPage(items: WorkflowBundle[], q: string) {
  return page(
    "Synthetic workflow demonstrations",
    `<section class="lesson-heading"><p class="eyebrow">LOCAL DRAFT PREVIEW · NOT REVIEWED FOR PUBLICATION</p><h1>Workflow demonstrations</h1><p class="lead">Explore three invented, text-only examples. No workflow runs here or connects to an AI provider or client system. Qualified review, reuse terms and live compatibility remain pending.</p><form method="get" action="/workflows"><label for="workflow-q">Search by title, goal or background</label><input id="workflow-q" name="q" value="${escape(q)}" maxlength="100"><button type="submit">Search</button></form></section><section aria-label="Synthetic workflows"><ul>${items.map((item) => `<li><a href="/workflows/${escape(item.id)}">${escape(item.title)}</a> · draft version ${item.version}<p>${escape(item.goal)} · ${escape(item.backgrounds)}</p></li>`).join("")}</ul>${items.length ? "" : "<p>No demonstration matches this search.</p>"}</section><p><a href="/learn">Return to learning</a></p>`,
  );
}
export function workflowDetailPage(item: WorkflowBundle) {
  return page(
    item.title,
    `<nav class="breadcrumb"><a href="/workflows">← Workflow demonstrations</a></nav><article class="reading"><p class="eyebrow">SYNTHETIC DRAFT · VERSION ${item.version} · REVIEW PENDING</p><h1>${escape(item.title)}</h1><p class="lead">This file is for manual study only. Downloading it does not run a workflow, call an AI provider, or connect to any client system.</p><dl><dt>Goal</dt><dd>${escape(item.goal)}</dd><dt>Backgrounds</dt><dd>${escape(item.backgrounds)}</dd><dt>Prerequisites</dt><dd>${escape(item.prerequisites)}</dd><dt>Setup</dt><dd>${escape(item.setup)}</dd><dt>Supported environment</dt><dd>${escape(item.supportedEnvironment)}</dd><dt>Estimated cost</dt><dd>${escape(item.estimatedCost)}</dd><dt>Permissions</dt><dd>${escape(item.permissions)}</dd><dt>License</dt><dd>${escape(item.license)}</dd><dt>Owner</dt><dd>${escape(item.owner)}</dd><dt>Last verification</dt><dd>${escape(item.lastVerification)}</dd><dt>Next review</dt><dd>${escape(item.nextReview)}</dd><dt>Readiness</dt><dd>${escape(item.readiness)}</dd><dt>Limitations</dt><dd>${escape(item.limitations)}</dd></dl><p><a class="button" href="/workflows/${escape(item.id)}/download">Download Markdown text</a></p><label for="workflow-copy">Select and copy the synthetic workflow text</label><textarea id="workflow-copy" readonly rows="16">${escape(item.body)}</textarea><p><a href="/workflow-feedback/${escape(item.id)}">Save private feedback about this draft</a></p><p class="small">You can suggest an original improvement as a <a href="/contribute?workflow=${escape(item.id)}">private version-pinned sample proposal</a>. It will not be published or executed from this preview.</p></article>`,
  );
}
export function workflowFeedbackPage(
  item: WorkflowBundle | null,
  reports: WorkflowFeedback[],
  csrf: string,
  id: string,
) {
  const current = item
    ? reports.find((report) => report.workflowVersion === item.version)
    : undefined;
  const history = reports.filter(
    (report) => !item || report.workflowVersion !== item.version,
  );
  const withdraw = (report: WorkflowFeedback) =>
    `<form method="post" action="/workflow-feedback/${escape(id)}/withdraw">${hidden(csrf)}<input type="hidden" name="workflow_version" value="${report.workflowVersion}"><input type="hidden" name="revision" value="${report.revision}"><label><input type="checkbox" name="confirm" value="yes" required> Remove my private note for version ${report.workflowVersion}</label><button class="secondary" type="submit">Withdraw version ${report.workflowVersion} feedback</button></form>`;
  return page(
    "Private workflow feedback",
    `<nav class="breadcrumb"><a href="/workflows/${escape(id)}">← Workflow demonstration</a></nav><section class="reading"><p class="eyebrow">PRIVATE LOCAL PREVIEW · SELF-REPORT ONLY</p><h1>Private feedback on ${escape(item?.title ?? id)}</h1><p class="lead">Only you can read this invented-text note. It is tied to one draft version and is not a publication request, qualified review, formal assessment or workflow execution.</p>${item ? `<p>Current synthetic draft version: ${item.version}. No AI provider or client system is connected.</p><form method="post" action="/workflow-feedback/${escape(id)}/save">${hidden(csrf)}<input type="hidden" name="workflow_version" value="${item.version}"><input type="hidden" name="revision" value="${current?.revision ?? 0}"><label for="workflow-note">Your private feedback on version ${item.version}</label><textarea id="workflow-note" name="note" maxlength="1000" required rows="6">${escape(current?.note ?? "")}</textarea><label><input type="checkbox" name="confirm" value="yes" required> I am saving private feedback using only invented text</label><button type="submit">Save private feedback</button></form>${current ? `<p role="status">Your note for version ${item.version} is saved privately. You can correct or withdraw it.</p>${withdraw(current)}` : ""}` : `<p role="status">This workflow draft is unavailable. Your historical note remains private and can be withdrawn; nothing is migrated to a new version.</p>`}${history.length ? `<h2>Historical version notes</h2><ul>${history.map((report) => `<li><p>Version ${report.workflowVersion}: historical draft note; it is not current or reviewed.</p><p>${escape(report.note)}</p>${withdraw(report)}</li>`).join("")}</ul>` : ""}</section>`,
  );
}
export function libraryPage(
  items: ContentVersion[],
  filters: { q: string; goal?: string; background?: string; domain?: string },
  history: LessonActivity[] = [],
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
    `<section class="lesson-heading"><p class="eyebrow">LOCAL PREVIEW · PUBLISHED VERSIONS ONLY</p><h1>Learning library</h1><p class="lead">Search released sample content. Drafts and retired versions are hidden; formal assessment is unavailable.</p><form method="get" action="/library"><label for="library-q">Search lessons and exercises</label><input id="library-q" name="q" value="${escape(filters.q)}" maxlength="100">${select("goal", "Goal", GOALS, filters.goal)}${select("background", "Background", BACKGROUNDS, filters.background)}${select("domain", "Domain", DOMAINS, filters.domain)}<button type="submit">Search</button></form></section><section aria-label="Published content"><ul>${items.map((item) => `<li><a href="/library/${escape(item.id)}">${escape(item.title)}</a> · ${escape(item.kind)} · version ${item.version} · ${escape(item.origin)}</li>`).join("")}</ul>${items.length ? "" : "<p>No published content matches. The foundation content pack is still awaiting qualified review.</p>"}</section><section aria-labelledby="reading-history-title"><h2 id="reading-history-title">Your private lesson history</h2><p>Opening a page records only that it opened. Starting and completing are separate actions; completion is your own report, not a skill assessment.</p>${history.length ? `<ul>${history.map((entry) => `<li>${escape(entry.contentId)} · version ${entry.contentVersion} · ${escape(lessonActivityStatus(entry))} · ${entry.available ? `<a href="/library/${encodeURIComponent(entry.contentId)}">Current lesson available</a>` : "This version is unavailable; your history remains saved"}</li>`).join("")}</ul>` : "<p>No sample lesson has been opened in this browser yet.</p>"}</section><p><a href="/learn">Return to your learning path</a></p>`,
  );
}
function lessonActivityStatus(activity: LessonActivity) {
  if (activity.selfAssessedAt) return "Self-assessed complete";
  if (activity.startedAt) return "Started";
  return "Opened in reader";
}
export function contentPreview(
  item: ContentVersion,
  staff: boolean,
  csrf = "",
  activity?: LessonActivity,
) {
  const base = `/editor/library/${encodeURIComponent(item.id)}/${item.version}`;
  const learning =
    !staff && item.kind === "lesson"
      ? `<section aria-labelledby="reader-progress-title"><h2 id="reader-progress-title">Your private reading activity</h2><p role="status">${activity ? escape(lessonActivityStatus(activity)) : "Opening not confirmed"} · version ${item.version}</p><p>Opening this text does not prove it was read or understood. No qualified reviewer has assessed this lesson.</p><p><a href="/library/${encodeURIComponent(item.id)}/study">Try a locally simulated study reflection</a> · <a href="/library/${encodeURIComponent(item.id)}/practice">Open private sample practice</a> · <a href="/library/${encodeURIComponent(item.id)}/practice-session">Try a private practice session</a></p>${activity && !activity.startedAt ? `<form method="post" action="/library/${encodeURIComponent(item.id)}/progress">${hidden(csrf)}<input type="hidden" name="content_version" value="${item.version}"><button type="submit" name="intent" value="start">Start this lesson</button></form>` : ""}${activity?.startedAt && !activity.selfAssessedAt ? `<form method="post" action="/library/${encodeURIComponent(item.id)}/progress">${hidden(csrf)}<input type="hidden" name="content_version" value="${item.version}"><label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I have finished reading this sample lesson; this is my own report.</span></label><button type="submit" name="intent" value="complete">Mark self-assessed complete</button></form>` : ""}${activity?.selfAssessedAt ? '<p><a href="/progress">Report whether this sample helped your next step</a></p>' : ""}</section>`
      : "";
  return page(
    item.title,
    `<nav class="breadcrumb"><a href="${staff ? "/editor/library" : "/library"}">← ${staff ? "Staff content" : "Learning library"}</a></nav><article class="reading"><p class="eyebrow">${staff ? "STAFF PREVIEW · " : "LOCAL PUBLISHED PREVIEW · "}${escape(item.state.toUpperCase())} · VERSION ${item.version}</p><h1>${escape(item.title)}</h1><p>${escape(item.kind)} · ${escape(item.origin)}</p>${!staff && item.kind === "lesson" ? "<p>Readable sample text · synthetic local preview. The six-lesson foundation and reviewed transcript are still pending.</p>" : ""}<dl><dt>Owner</dt><dd>${escape(item.owner)}</dd><dt>Sources</dt><dd>${escape(item.sources)}</dd><dt>Rights</dt><dd>${escape(item.rights)}</dd><dt>Goals</dt><dd>${escape(item.goals.join(", ") || "All")}</dd><dt>Backgrounds</dt><dd>${escape(item.backgrounds.join(", ") || "All")}</dd><dt>Domains</dt><dd>${escape(item.domains.join(", ") || "All")}</dd><dt>Suggested experience</dt><dd>${escape(EXPERIENCE[item.minimumExperience ?? "new"])} (self-reported)</dd><dt>Prerequisites</dt><dd>${escape(prerequisiteDescription(item))}</dd><dt>Review date</dt><dd>${item.reviewedAt ? escape(item.reviewedAt.toISOString().slice(0, 10)) : "Pending"}</dd></dl>${item.requiresQualifiedSignoff ? '<p role="status">Qualified curriculum and domain sign-off is pending. This draft cannot be approved or published.</p>' : ""}<h2>Content text</h2><pre class="content-text">${escape(item.body)}</pre>${item.rubric ? `<h2>Versioned rubric ${item.rubricVersion}</h2><pre class="content-text">${escape(item.rubric)}</pre>` : ""}${learning}${staff ? `<section aria-label="Content workflow"><form method="post" action="${base}/submit">${hidden(csrf)}<button>Submit for review</button></form><form method="post" action="${base}/approve">${hidden(csrf)}<label class="check"><input type="checkbox" name="rights_confirmed" value="yes" required><span>I checked the source and rights statement for this synthetic item.</span></label><button>Approve synthetic review</button></form><form method="post" action="${base}/publish">${hidden(csrf)}<button>Publish to local library</button></form><form method="post" action="/editor/library/${encodeURIComponent(item.id)}/retire">${hidden(csrf)}<button>Retire published versions</button></form></section>` : ""}</article>`,
  );
}
export function studyReflectionPage(
  item: ContentVersion,
  goal: Learner["goal"],
  csrf: string,
  feedback: string | null = null,
  error: string | null = null,
) {
  const source = `${item.id} · version ${item.version}`;
  return page(
    `Study reflection · ${item.title}`,
    `<nav class="breadcrumb"><a href="/library/${encodeURIComponent(item.id)}">← Current lesson</a></nav><section class="reading"><p class="eyebrow">LOCAL STUDY PREVIEW · LOCALLY SIMULATED</p><h1>Study reflection</h1><p>This published sample is synthetic and has not received qualified foundation sign-off. No live AI provider, paid allowance or formal reviewer is connected. Use invented information only.</p><p>Your current goal: ${escape(GOALS[goal])}. No career path is required.</p><h2>Source: ${escape(source)}</h2><pre class="content-text">${escape(item.body)}</pre><p>Which idea from this source could help with your goal, and what would you check before using it?</p>${error ? notice([error]) : ""}${feedback !== null ? `<section aria-labelledby="study-feedback-title"><h2 id="study-feedback-title">Compare your reflection with the source</h2><p>Your words: ${escape(feedback)}</p><p>Return to ${escape(source)} above. Does your example rely on a fact the source did not supply? What would a person need to verify?</p><p>This deterministic prompt is not a competence assessment, generated answer or formal review. Your reflection was not saved or sent to an AI provider; opening this page again will clear it.</p></section>` : ""}<form method="post" action="/library/${encodeURIComponent(item.id)}/study">${hidden(csrf)}<input type="hidden" name="content_version" value="${item.version}"><label for="reflection">Your short reflection (sample information only)</label><textarea id="reflection" name="reflection" maxlength="1000" required></textarea><label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I used only invented or sample information.</span></label><button type="submit">Compare with source</button></form><p>Your reflection is processed only for this response. It is not saved as lesson progress. <a href="/library">Return to the learning library</a>.</p></section>`,
  );
}
export function practiceSessionRecoveryPage(title: string, message: string) {
  return page(
    title,
    `<section class="reading"><h1>${escape(title)}</h1><p>${escape(message)}</p><p><a href="/practice-sessions">Inspect private session history</a> · <a href="/library">Open the learning library</a></p></section>`,
  );
}
export function practiceSessionStartPage(
  source: PracticeSessionSource,
  csrf: string,
) {
  return page(
    "Start private practice session",
    `<nav class="breadcrumb"><a href="/library/${encodeURIComponent(source.contentId)}">← Current lesson</a> · <a href="/practice-sessions">Private session history</a></nav><section class="reading"><p class="eyebrow">LOCAL PRACTICE · SIMULATED · UNREVIEWED · SAMPLE ONLY</p><h1>Start private practice session</h1><h2>${escape(source.title)}</h2><p>Source ${escape(source.contentId)} · version ${source.contentVersion}. Goal: ${escape(GOALS[source.goal])}. Prompt version: ${escape(source.promptVersion)}.</p><p>Opt into a private conversation using invented or sample information only. Each saved response receives one deterministic local source comparison. No live AI provider, paid allowance or qualified reviewer is connected. This simulation cannot judge competence.</p><p>A session holds up to 15 response/comparison pairs, or 30 visible turns. These initial instructions do not count. Saved pairs stay in order and cannot be overwritten. Starting again returns the same exact source, goal and prompt slot.</p><h2>Permitted source excerpt</h2><pre class="content-text">${escape(source.sourceExcerpt)}</pre><h2>Practice prompt</h2><p>${escape(source.prompt)}</p><form method="post" action="/library/${encodeURIComponent(source.contentId)}/practice-session/start">${hidden(csrf)}<input type="hidden" name="content_version" value="${source.contentVersion}"><input type="hidden" name="goal" value="${escape(source.goal)}"><input type="hidden" name="prompt_version" value="${escape(source.promptVersion)}"><label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I want to start private sample practice using only invented or sample information.</span></label><button type="submit">Start or return to private session</button></form><p>Your saved responses, comparisons and excerpts remain private until withdrawal or account deletion. Withdrawal keeps a content-free marker and cannot be undone. Previously downloaded copies cannot be recalled.</p><p><a href="/library/${encodeURIComponent(source.contentId)}/practice">Open one-note practice</a></p></section>`,
  );
}
export function practiceSessionHistoryPage(history: {
  items: PracticeSessionSummary[];
  nextCursor: string | null;
}) {
  return page(
    "Private session history",
    `<section class="reading"><h1>Private session history</h1><p>Only your signed-in account can read these local sample sessions. Each page lists at most 20 sessions. Stored pairs remain tied to their exact source, goal and prompt; unavailable sources do not generate new comparisons.</p>${history.items.length ? `<ol aria-label="Saved practice sessions">${history.items.map((item) => `<li><a href="/practice-sessions/${encodeURIComponent(item.id)}">${escape(item.contentId)} · version ${item.contentVersion} · ${escape(GOALS[item.goal])}</a><p>Prompt ${escape(item.promptVersion)} · started ${escape(item.createdAt.toISOString())}${item.withdrawnAt ? ` · Withdrawn ${escape(item.withdrawnAt.toISOString())}; response, comparison and excerpt text removed` : " · Private retained session"}</p></li>`).join("")}</ol>` : "<p>No private sessions are saved yet. Choose a published sample lesson to opt in.</p>"}${history.nextCursor ? `<p><a href="/practice-sessions?after=${encodeURIComponent(history.nextCursor)}">Next session page</a></p>` : ""}<p><a href="/member/export">Download private preview records</a> · <a href="/practice">One-note practice history</a> · <a href="/library">Learning library</a></p></section>`,
  );
}
export function practiceSessionPage(
  detail: PracticeSessionDetail,
  csrf: string,
) {
  const status = {
    available: "You can add the next invented response.",
    "source-unavailable":
      "This exact source or your current goal is unavailable for continuation. Saved pairs are read-only. Restore the same goal only if the pinned source is still eligible.",
    "unknown-template":
      "This pinned prompt version is unavailable. Saved pairs are read-only; no new comparison can be generated.",
    withdrawn:
      "Session withdrawn. All response, comparison and excerpt text was removed. Only content-free source, goal, version and time metadata remains. This slot cannot be restarted.",
    full: "Session complete: 15 pairs / 30 visible turns. This session cannot accept another response.",
  }[detail.availability];
  const base = `/practice-sessions/${encodeURIComponent(detail.id)}`;
  const withdrawn = detail.availability === "withdrawn";
  return page(
    "Private practice session",
    `<nav class="breadcrumb"><a href="/practice-sessions">← Private session history</a> · <a href="/library">Learning library</a></nav><section class="reading"><p class="eyebrow">LOCAL PRACTICE · SIMULATED · UNREVIEWED · SAMPLE ONLY</p><h1>Private practice session</h1><p>Source ${escape(detail.contentId)} · version ${detail.contentVersion}. Goal: ${escape(GOALS[detail.goal])}. Prompt version: ${escape(detail.promptVersion)}. Started ${escape(detail.createdAt.toISOString())}.</p><p>No live AI provider, paid allowance or qualified reviewer is connected. These deterministic comparisons cannot judge competence; there is insufficient evidence for formal assessment.</p><p role="status">${escape(status)}</p>${withdrawn ? `<p>Withdrawn ${escape(detail.withdrawnAt!.toISOString())}.</p>` : `<h2>${escape(detail.title)}</h2>${detail.prompt ? `<h2>Practice prompt</h2><p>${escape(detail.prompt)}</p>` : ""}<p>${detail.exchanges.length} of 15 saved pairs · ${detail.exchanges.length * 2} of 30 visible turns. Initial instructions do not count.</p>${detail.exchanges.length ? `<ol aria-label="Saved response and comparison pairs">${detail.exchanges.map((pair) => `<li><article aria-label="Pair ${pair.sequence}"><h2>Pair ${pair.sequence}</h2><h3>Your response · turn ${pair.sequence * 2 - 1}</h3><pre class="content-text" data-practice-response>${escape(pair.response)}</pre><h3>Local comparison · turn ${pair.sequence * 2}</h3><pre class="content-text" data-practice-comparison>${escape(pair.comparison)}</pre><h4>Exact source excerpt · ${escape(detail.contentId)} · version ${detail.contentVersion}</h4><pre class="content-text">${escape(pair.sourceExcerpt)}</pre><p class="small">Saved ${escape(pair.acceptedAt.toISOString())} · simulated, unreviewed and uncertain.</p></article></li>`).join("")}</ol>` : "<p>No responses saved yet.</p>"}${detail.availability === "available" && detail.nextSequence !== null ? `<form method="post" action="${base}/responses">${hidden(csrf)}<input type="hidden" name="expected_sequence" value="${detail.nextSequence}"><label for="session-response">Your next sample response (up to 1,000 characters)</label><textarea id="session-response" name="response" maxlength="1000" required></textarea><label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I used only invented or sample information and want to save this response.</span></label><button type="submit">Save response and compare</button></form>` : ""}<form method="post" action="${base}/withdraw">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Remove all response, comparison and source-excerpt text from this exact session. Keep a content-free marker.</span></label><button type="submit" class="secondary">Withdraw session text</button></form>`}<p><a href="/member/export">Download private preview records</a></p><p>Withdrawal removes saved text from this local preview. Previously downloaded copies and hosted backup erasure are outside this preview.</p></section>`,
  );
}
export function privatePracticePage(
  source: PracticeSource,
  csrf: string,
  error: string | null = null,
  attempted = "",
) {
  const prompt = {
    everyday:
      "Where might this source help in an everyday situation, and what detail would you verify first?",
    work: "Where might this source help in professional work, and what detail would you verify first?",
    build:
      "How might you apply this source in a small build, and what detail would you verify first?",
  }[source.goal];
  const response = source.response;
  const withdrawn = source.withdrawnAt !== null;
  return page(
    `Private sample practice · ${source.title}`,
    `<nav class="breadcrumb"><a href="/library/${encodeURIComponent(source.id)}">← Current lesson</a> · <a href="/practice">Private practice history</a></nav><section class="reading"><p class="eyebrow">LOCAL PRACTICE · SIMULATED · UNREVIEWED · SAMPLE ONLY</p><h1>Private sample practice</h1><p><a href="/library/${encodeURIComponent(source.id)}/practice-session">Try a private practice session</a> for several saved responses and local comparisons.</p><p>Published synthetic lesson ${escape(source.id)} · version ${source.version}. No live AI provider or formal reviewer is connected.</p><p>Use invented or sample information only. A saved note stays private to this exact lesson version until you withdraw it or delete your account. It is not the separate, unsaved study reflection.</p><h2>Permitted source</h2><pre class="content-text">${escape(source.body)}</pre><h2>Practice prompt</h2><p>${escape(prompt)}</p>${error ? notice([error]) : ""}${withdrawn ? `<p role="status">This version's private note was withdrawn. Its response and comparison are no longer available, and this version cannot accept another note. <a href="/practice">Inspect private practice history</a>.</p>` : response !== null ? `<section aria-labelledby="practice-feedback-title"><h2 id="practice-feedback-title">Your saved sample and source comparison</h2><p>Your words: ${escape(response)}</p><p>Compare those words with ${escape(source.id)} · version ${source.version} above. Which part is supported by the source, and which detail still needs checking?</p><p>This deterministic prompt is not an evaluation. There is insufficient evidence here to judge competence or provide formal assessment.</p><p>This version accepts one note. Reloading shows the saved note; a different response cannot overwrite it.</p></section>` : `<form method="post" action="/library/${encodeURIComponent(source.id)}/practice">${hidden(csrf)}<input type="hidden" name="content_version" value="${source.version}"><label for="practice-response">Your sample response (up to 1,000 characters)</label><textarea id="practice-response" name="response" maxlength="1000" required>${escape(attempted)}</textarea><label class="check"><input type="checkbox" name="synthetic" value="yes" required><span>I used only invented or sample information and want to save this private note.</span></label><button type="submit">Save private practice</button></form>`}<p><a href="/library">Return to the learning library</a></p></section>`,
  );
}
export function privatePracticeHistoryPage(
  history: PracticeHistory[],
  csrf: string,
) {
  return page(
    "Private practice history",
    `<section class="reading"><h1>Private practice history</h1><p><a href="/practice-sessions">Private session history</a></p><p>These sample responses are visible only in your signed-in account. You can withdraw one response; a content-free withdrawn marker remains for that exact version until account deletion and prevents another note in that slot. A source that has changed remains tied to its original version; no new feedback is generated for an unavailable version.</p>${
      history.length
        ? `<ul>${history
            .map(
              (entry) =>
                `<li><strong>${escape(entry.title)}</strong> · ${escape(entry.id)} · version ${entry.version} · ${entry.withdrawnAt ? `<span role="status">Withdrawn ${escape(entry.withdrawnAt.toISOString())}</span>${entry.available ? "" : " · Source unavailable"}<p>The response and source comparison were removed. This version cannot accept another note.</p>` : `${entry.available ? `<a href="/library/${encodeURIComponent(entry.id)}/practice">Current source and saved comparison</a>` : "Source unavailable; saved private note only"}<p>Your saved words: ${escape(entry.response!)}</p><form method="post" action="/practice/${encodeURIComponent(entry.id)}/${entry.version}/withdraw">${hidden(csrf)}<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>Withdraw this exact version's private note. Its response and comparison will be removed; a content-free marker remains until account deletion.</span></label><button type="submit">Withdraw private note</button></form>`}</li>`,
            )
            .join("")}</ul>`
        : "<p>No private practice is saved yet.</p>"
    }<p><a href="/library">Learning library</a></p></section>`,
  );
}
export function staffLibraryPage(
  items: ContentVersion[],
  csrf: string,
  attempted: Record<string, unknown> = {},
  errors: string[] = [],
) {
  const value = (name: string) =>
    typeof attempted[name] === "string" ? escape(attempted[name]) : "";
  const selected = (name: string) => {
    const raw = attempted[name];
    return Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  };
  const tagChecks = (
    name: string,
    label: string,
    choices: Record<string, string>,
  ) =>
    `<fieldset><legend>${label}</legend><div class="option-grid">${Object.entries(
      choices,
    )
      .map(
        ([key, description]) =>
          `<label class="check"><input type="checkbox" name="${name}" value="${key}"${selected(name).includes(key) ? " checked" : ""}><span>${escape(description)}</span></label>`,
      )
      .join("")}</div></fieldset>`;
  const option = (name: string, key: string, label: string, fallback: string) =>
    `<option value="${key}"${(value(name) || fallback) === key ? " selected" : ""}>${label}</option>`;
  return page(
    "Staff content drafts",
    `<section class="lesson-heading"><p class="eyebrow">LOCAL STAFF PREVIEW</p><h1>Content workflow</h1><p><a href="/review/worklist">Your sample feedback worklist</a> (reviewer access required)</p><p>PLAN-004 assets are unreviewed drafts and require separate qualified sign-off. Synthetic staff testing does not supply that approval.</p></section><ul>${items.map((item) => `<li><a href="/editor/library/${escape(item.id)}/${item.version}">${escape(item.title)}</a> · ${escape(item.state)} · version ${item.version}</li>`).join("")}</ul><section>${errors.length ? "<h2>Draft not saved</h2>" : ""}<h2>Create a synthetic draft</h2>${notice(errors)}<form method="post" action="/editor/library">${hidden(csrf)}<label for="content-id">Content ID</label><input id="content-id" name="id" value="${value("id")}" required pattern="[A-Z]{2,5}-[0-9]{3}"><label for="content-version">Version</label><input id="content-version" name="version" type="number" min="1" value="${value("version")}" required><label for="content-kind">Kind</label><select id="content-kind" name="kind">${option("kind", "lesson", "Lesson", "lesson")}${option("kind", "assignment", "Assignment", "lesson")}${option("kind", "workflow", "Workflow", "lesson")}${option("kind", "community", "Community", "lesson")}</select><label for="content-title">Title</label><input id="content-title" name="title" value="${value("title")}" required><label for="content-body">Body</label><textarea id="content-body" name="body" required>${value("body")}</textarea><label for="content-owner">Owner</label><input id="content-owner" name="owner" value="${value("owner")}" required><label for="content-sources">Sources</label><input id="content-sources" name="sources" value="${value("sources")}" required><label for="content-rights">Rights</label><input id="content-rights" name="rights" value="${value("rights")}" required><p class="small">Audience tags are optional. Leaving a group empty means any learner in that group. These labels do not grant staff or paid access.</p>${tagChecks("goals", "Goal tags (optional)", GOALS)}${tagChecks("backgrounds", "Background tags (optional)", BACKGROUNDS)}${tagChecks("domains", "Domain tags (optional)", DOMAINS)}<label for="content-minimum-experience">Suggested experience</label><select id="content-minimum-experience" name="minimum_experience">${option("minimum_experience", "new", "Just starting", "new")}${option("minimum_experience", "some", "Some practice", "new")}${option("minimum_experience", "experienced", "Experienced", "new")}</select><label for="content-prerequisites">Legacy prerequisite (optional)</label><input id="content-prerequisites" name="prerequisites" value="${value("prerequisites")}" placeholder="None or LOCAL-FIRST-EXERCISE-COMPLETE"><label for="content-structured-prerequisites">Structured prerequisites JSON (optional)</label><textarea id="content-structured-prerequisites" name="structured_prerequisites" rows="5" placeholder='{"schemaVersion":1,"all":[]}'>${value("structured_prerequisites")}</textarea><p class="small">Use one format only. Structured requirements name published synthetic lesson versions and observed started/self-assessed activity, or clear-instructions version 1 completion. Unknown or retired sources stay unavailable.</p><label for="content-rubric">Assignment rubric (optional)</label><textarea id="content-rubric" name="rubric" maxlength="10000">${value("rubric")}</textarea><label for="content-rubric-version">Rubric version (required with rubric)</label><input id="content-rubric-version" name="rubric_version" type="number" min="1" step="1" value="${value("rubric_version")}"><p class="small">Use both rubric fields for a synthetic assignment. Each new content version saves its own rubric; this local sample is not qualified instruction or formal human assessment.</p><button type="submit">Save draft</button></form></section>`,
  );
}
