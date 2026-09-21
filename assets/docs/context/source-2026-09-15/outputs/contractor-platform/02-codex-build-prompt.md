# Codex build prompt — Contractor Success Platform

You are my product, engineering, and implementation partner. Build the private MVP described below in the active project. This is an implementation assignment: create working software, run appropriate checks, inspect the browser experience, and leave a clear release handoff. Do not stop after proposing an architecture or producing placeholder screens.

If the companion business plan, backlog, evidence register, and financial workbook are attached, read them and use their detailed definitions. This prompt contains the essential requirements and is usable on its own. Later explicit user instructions override these initial choices. If documents conflict, identify the conflict and follow the latest confirmed user direction; do not silently change pricing or scope.

## 1. Confirmed business requirements

- Serve **individual independent IT contractors first**, including people who invoice through their own corporations.
- Welcome **all IT contractor roles from day one**. Do not change the business into a developer-only, QA-only, staffing-agency, or employer platform.
- The target price range is **CAD 10,000 through the low six figures paid annually by each contractor**. It is not a contractor-income range or the company's total annual revenue goal.
- Combine AI training, domain learning, online study materials, coaching, virtual interviews, assessed practical projects, maintained agent workflows, and professional-development/renewal support.
- The proposed subscription ladder is Professional CAD 12,000, Specialist CAD 24,000, Practice CAD 48,000, and Partner CAD 120,000 per year, before applicable taxes.
- Launch the Professional service through a CAD 3,000 standalone pilot. Higher tiers are future service designs with real staffing and commercial gates, not immediately purchasable products.
- The working product name is Contractor Success Platform. Keep branding configurable; no domain or trademark availability is assumed.
- English is the initial language; Canadian-dollar billing and Canadian operating preparation are defaults. Remote delivery is supported. The business province, legal entity, expert roster, and permitted sale countries are not yet confirmed.

The product helps members build relevant skills, demonstrate them through reviewed work, and apply them with tools and expert support. Do not promise jobs, income, rate increases, recognized accreditation, guaranteed interview success, or universal expert coverage.

## 2. Scope and execution approach

First inspect the current repository, its AGENTS.md files, git state, existing product, design system, infrastructure, and tests. Reuse sound existing work. Preserve unrelated changes. If the active directory contains only this planning package, create the application in a clearly named `contractor-platform-app/` subdirectory without overwriting the documents. Do not copy code or private course content from other projects unless the user has authorized the source and its usage rights are clear.

Use reasonable defaults for reversible implementation decisions and record them in `docs/decisions.md`. Do not repeatedly ask for stack, colours, folder structure, or naming approval. Ask only when a missing business fact materially prevents a dependent action; continue independent work.

If starting fresh, use a coherent TypeScript web application, a relational PostgreSQL database, migrations, private file storage, server-side authorization, and background jobs. Next.js is a suitable default. Use maintained versions and check official documentation when implementing provider integrations. Prefer a modular monolith. Do not start with microservices or build a generic agent marketplace.

Create and maintain:

- `docs/product.md`: current product scope and business rules.
- `docs/decisions.md`: defaults, reasons, and unresolved choices.
- `docs/roadmap.md`: milestones and later service gates.
- `docs/backlog.md`: stable issue IDs, dependencies, acceptance, status, and evidence.
- `docs/validation.md`: checks run, environment, exact source revision or working-tree snapshot, results, and unverified integrations.
- `docs/operations.md`: capacity, content, support, billing exceptions, and incident procedures.
- `docs/launch-readiness.md`: prerequisites for real members, real payments, and publication.
- `docs/next-session.md`: completed work and the next concrete step if a run is interrupted.

Use subagents for genuinely independent tasks when available, with clear file ownership. Keep dependent changes coordinated. Preserve progress through checkpoints and resumable notes. Do not mark a feature complete based solely on generated code or a screenshot.

Implement the whole private MVP in this prompt, proceeding through the milestones below. Later roadmap phases are documented and gated. Do not implement the entire future business in the first release.

## 3. Product experience

Design a calm, professional, accessible workspace. Use plain language, clear hierarchy, and generous spacing. The primary dashboard shows the member's next action, the reason it matters, their scheduled support, and progress evidence. It should work on desktop and mobile without a dense grid of unrelated features.

Avoid empty navigation, fake social proof, fake customers, fictional testimonials, fabricated coach credentials, invented success rates, or charts populated with synthetic data without a visible demo label. Keep provider names, internal job IDs, prompts, and model diagnostics out of ordinary member flows unless needed to make a meaningful choice. Put operator diagnostics in the operator workspace.

Support these roles at intake, with stable configurable taxonomy IDs: software development; QA/test engineering; data/analytics/applied AI; cloud/DevOps/SRE; cybersecurity; architecture; business analysis; project/program/delivery; product ownership/product management; and an additional-specialty option.

Members may select multiple roles and a current goal. Published paths use explicit readiness states: available, limited coverage, in preparation, or retired. Readiness depends on actual material and required human coverage. All roles can access the shared foundation. Tailored paid work requires an available qualified expert. Unsupported specialties receive a clear explanation and waitlist option before a tailored service is sold.

The member journey is:

Application → accepted scope → pilot activation → onboarding → baseline → learning plan → lesson → practical assignment → expert feedback → revision → mock practice → coaching → progress review → explicit continuation decision.

## 4. Commercial rules: canonical configuration

Store money as integer CAD cents and store price, terms, and entitlement definitions in immutable offer versions. Historical purchases retain their offer version. Publish one source of truth to the UI, billing logic, and quota calculations.

### Professional annual program

- CAD 12,000 for twelve service months.
- Direct entry: CAD 12,000 prepaid or twelve CAD 1,000 instalments over a twelve-month term.
- Renewal: a new twelve-month term, subject to disclosed renewal and notice arrangements.
- Instalment collection is not automatically a cancel-anytime subscription.
- No automatic real renewal, charge, or external communication occurs in the development environment.

### Pilot and continuation

- CAD 3,000 standalone pilot for the first two billing months, with instruction across eight weeks.
- Pilot start is the original first-year membership anchor.
- The pilot does not auto-convert.
- On explicit acceptance, CAD 9,000 purchases the **remaining ten months** of the first membership year, prepaid or ten CAD 900 instalments.
- The total first-year price is CAD 12,000, including the pilot. Do not double count the CAD 3,000, start another twelve-month term at conversion, or issue duplicate annual allowances.
- Standard continuation must be accepted by the end of the second billing period and takes effect immediately at month three. A late return requires a separately priced, manually approved agreement with explicit service dates and credit treatment. Do not automatically charge for undelivered time, grant retroactive allowances, or sell ten remaining months before an anniversary that is less than ten months away.
- Billing dates use actual month arithmetic with an end-of-month rule. Eight instruction weeks do not mean that two calendar months always contain 56 days.
- Cancellation at term end is self-service; early release, refunds, hardship, and disputes are logged operator workflows based on reviewed terms. Do not invent final legal policy in code.

### Human allowances

Professional monthly allowance: 60 coaching minutes including preparation/notes, 30 qualified review minutes including preparation/notes, and 30 support minutes. The normal coaching appointment is 45 minutes with 15 minutes reserved for preparation. A standard review uses approximately 20 review minutes and 10 preparation minutes. Human-led mock interviews use coaching credits, including preparation; there is no separate free human-mock allowance.

Pilot total: two such coaching appointments, four 30-minute review allocations, and two 60-minute monthly support allocations. Add one onboarding allocation of 60 coaching minutes and 30 support minutes in the operating capacity budget. Do not charge that internal onboarding cost again to the member beyond the pilot price.

Map onboarding to the baseline conversation, permissions, and initial plan; the first regular coaching call to development planning; the second to closing review and next-quarter actions. Allocate the four project reviews to baseline work, first draft, revision, and final assessment. Each review has an agreed artifact section and at most three rubric criteria within its time budget. There is no additional uncosted closing session. At continuation, explicitly compare pilot review/support frequency with the lower ongoing allowance and record the member's intended recurring use. Include a 90-day usefulness check.

All Professional and pilot members may attend four pooled one-hour general clinics per month, with a maximum group size of 16. General clinics are not a promise of senior expertise in every domain. Group delivery is accounted for once per actual staffed group.

Future monthly capacity templates:

| Plan | Annual CAD | Coach | Domain reviewer | Implementation/engineering | Other | Support |
|---|---:|---:|---:|---:|---|---:|
| Specialist | 24,000 | 2h | 1h | 1h implementation | None | 1h |
| Practice | 48,000 | 3h | 2h | 3h engineering | None | 2h |
| Partner | 120,000 | 4h | 4h | 12h engineering | 2h senior advisor + 8h analyst | 4h |

These plans remain disabled for checkout until published by an authorized operator with a versioned scope and capacity. Partner serves an established individual consulting business through a custom statement of work; do not change the customer into an employer or assume software alone delivers the promised managed service.

### AI and booking limits

Professional and pilot monthly AI limits: 20 text interview sessions, each at most 30 turns; 100 study-assistant requests. Specialist: 40/200. Practice: 60/300. Partner: explicit negotiated caps. Enforce input sizes, token limits, concurrency, per-workspace budgets, and global emergency spend limits server-side. Costs are measured separately from customer-visible usage units. A paid entitlement must not silently disappear when an operator changes future-plan pricing or limits.

Monthly grants are anchored to the membership anniversary, not calendar months. Standard credits do not roll over; platform-caused cancellations create explicitly dated replacement credits. Reserve a booking slot and the required service credit atomically. A platform failure restores a reserved AI unit. A completed request with a low user rating is not automatically an unlimited retry.

Proposed rescheduling threshold: 24 hours before the appointment, shown in the member's local time. Staff cancellation restores the credit. A member no-show can consume it only under the accepted policy. Show remaining credit and real provider availability separately.

## 5. Functional modules required in the private MVP

### A. Public offer and applications

Provide all-role positioning, a truthful sample, exact pilot/annual terms, coverage readiness, and a fit application. Track requested role/domain, objective, schedule, and application status. Acceptance requires a named available reviewer where tailored review is promised. An application is not an active membership or successful payment.

### B. Identity, onboarding, and permissions

Create private individual workspaces. Support member, assigned coach, assigned reviewer, content editor, operator, and platform administrator permissions. A member cannot assign themselves staff roles. Coaches see only purpose-scoped assigned material. Operators see metadata by default and use logged, time-bounded support access for member content. Editors do not receive private submissions automatically.

Onboarding captures goals, roles, domain interests, weekly learning availability, timezone, and sharing/AI-processing preferences. Client names, income, and assignment dates are optional. Do not collect identity documents, client credentials, or complete employment contracts for routine onboarding.

### C. Learning paths and content

Provide a shared foundation and role branches, lesson reader, transcripts, exercises, search/filter, progress, and content versioning. Editors draft, preview, review, publish, and retire content. Every substantive domain pack and workflow has a named accountable reviewer, sources, version, and last-review date. Placeholder reviewer names must not masquerade as real approvals.

Seed six concise common-foundation lessons, one realistic exercise brief for every role family, and two complete demonstration assignments with reference outputs (QA and business analysis are suitable examples). Seed assets are synthetic demonstration material and explicitly labelled. Do not count generated examples as expert-reviewed paid curriculum. The content workflow must permit real experts to review and publish them later.

### D. Projects, evidence, and assessment

Members submit versioned files or text against a specific assignment and rubric. Implement file size/type limits, quarantine/processing state, private storage, short-lived authorized downloads, and explicit sharing. Reject unsafe types and do not execute uploaded files. Pin the assessed submission and rubric versions.

AI may draft observations linked to evidence. Only an assigned human reviewer publishes a formal assessment. Show self-reported, AI-suggested, and human-reviewed evidence distinctly. Sparse evidence returns an insufficient-evidence result. Members can request clarification or a bounded appeal. A public portfolio is off by default and requires deliberate member-controlled sharing with expiry and revocation; shared work states whether it is simulated or paid client work.

### E. Text mock interviews and tutoring

Implement role-specific text sessions, follow-up questions, saved history, and rubric-linked feedback. Model outputs use a validated structure and evidence references. An interview is practice, not a hiring prediction or psychometric assessment. Avoid numerical scores until a rubric and its interpretation are explicitly defined; plain criterion states are sufficient for MVP.

Use published content and authorized workspace material. Treat uploaded text and retrieved documents as data, not instructions granting tools or broader access. Log model/prompt/rubric versions without putting raw personal content in routine telemetry. Test unsupported answers, prompt injection, wrong-role scenarios, missing content, provider outage, malformed results, and deletion.

Voice/video and recording are later features. Provide a clean adapter boundary and document consent/deletion requirements; do not implement fake microphone success or require audio to complete the MVP.

### F. Maintained agent workflow library

Provide search/filter, version detail, prerequisites, supported environment, sample inputs/outputs, tests, estimated cost, permissions, limitations, license, owner, last verification, download/copy, and feedback. Seed three demonstration workflows: requirements-to-acceptance drafting, test-case review, and meeting-action extraction from synthetic text.

Do not execute arbitrary user code on the server. Hosted agents, live client-system access, automatic emails, and repository-writing integrations are future work with separate scope and safeguards.

### G. Coaching and service operations

Provide real available slots, member timezone display, booking holds, capacity reservation, cancellation, notes, review worklists, and time recording. Service time includes preparation. Unavailable experts cannot be sold as available. Capacity is checked by specialty, service type, and time window, not only total hours.

Professional support acknowledgement target is two business days within published staffing hours, initially Monday–Friday 09:00–17:00 Eastern excluding the published holiday calendar. Distinguish acknowledgement from resolution. Meeting links may be manually entered by staff. Do not claim email/calendar invitations were sent when those integrations are unconfigured.

### H. Membership, billing, and entitlement operations

Show accepted terms, service phase, original anniversary, invoices, payments, quotas, usage ledger, cancellation request, and actual integration status. Implement deterministic payment test events and a payment-provider adapter. A live adapter uses official signature verification, idempotent processing, event-order handling, reconciliation, and separation between invoice, payment, and service access.

Duplicate successful events cannot grant two memberships or duplicate credits. A stale failed-payment event cannot revoke a later-paid term. A failed invoice does not pretend to be refunded. Operator adjustments and refunds have a reason and audit trail. Taxes, refunds, gross collections, earned service, and deferred service amounts remain distinct.

Define application, membership, invoice, provider-payment, and entitlement states independently. Do not collapse everything into an `active` Boolean. At minimum handle accepted/unpaid, pilot-active, pilot-complete, continuation-offered, continuation-active, past-due, cancellation-scheduled, ended, refunded, and disputed using separate relevant state machines.

### I. Continuing development

Members can maintain quarterly goals, optional assignment end dates, renewal preparation, and an opportunity list they enter themselves. No external job feed or client introductions are promised. Draft communications stay drafts until the member deliberately exports or sends them through a configured and authorized flow.

### J. Administration, privacy, and measurement

Provide capacity view, application queue, content readiness, AI job failures/costs, support queue, consent log, audit events, export/deletion requests, and operational metrics. Track activation, assessed completion, continuation, use after 30 days, costs, review turnaround, and renewal eligibility with explicit denominators.

Keep simulated transactions out of production metrics. Do not count account creation as paid acquisition, session attendance as validated skill, or member-reported income as causally produced revenue.

## 6. Data and technical invariants

Use these logical entities as a guide; create tables when their feature enters the implementation:

- Users, workspaces, roles, member-role selections, staff assignments, scoped access grants.
- Expert specialties, coverage, availability, slots, bookings, and booking events.
- Applications, agreements, offer versions, orders, subscription phases, invoices, payment events.
- Entitlement definitions, grant accounts, append-only ledger entries, holds, and settlements.
- Role/domain taxonomy, pathways, content versions, sources, enrollments, and progress.
- Assignments, rubric versions, submission versions, evidence objects, reviews, and appeals.
- Interview scenarios, sessions, turns, feedback runs, and AI evaluation cases.
- Template versions, compatibility tests, and feedback.
- Goals, assignment dates, shared session notes, action items, and opportunity records.
- AI jobs, budget reservations, usage/cost events, notification outbox, consents, audit events, privacy requests, and deletion jobs.

Every private entity belongs to a workspace. Enforce cross-record ownership in the server and database where feasible. Never trust a client-supplied workspace ID, price, balance, staff role, or payment status.

Entitlement history is append-only. Represent grants, reservation, settlement, release, expiry, and adjustments explicitly, with idempotency keys. Use integer minutes and usage units. Balance checks and booking/usage reservations run in transactions. Concurrency cannot overspend the last credit or double-book the last slot.

Store timestamps in UTC with IANA timezones for display and recurring schedules. Test daylight-saving changes, end-of-month anchors, expired holds, reschedules, and cancellations.

Store billing and provider identifiers separately from member evidence. Never store card details or secrets in client code. Environment-specific databases, buckets, webhook secrets, and credentials must isolate demonstration and production data.

Do not put confidential documents, full interview transcripts, raw prompts, access tokens, or client identifiers in general logs. Make retention and deletion cover files, extracted text, embeddings, generated feedback, and derived material. Document backup retention and records that must be retained for legitimate billing requirements; do not promise instantaneous removal from all backups.

## 7. Integrations and honest demonstration mode

Use adapters for authentication, storage, AI, payments, email, calendar, and analytics. Keep a deterministic demo implementation that works locally with synthetic fixtures. Label the environment prominently as a demonstration. Use explicit demo payment IDs and sample users. Test-only impersonation must never work in a live deployment.

Missing credentials are not a reason to stop all useful work. Complete the demo-backed flow, provider interface, configuration validation, tests, and setup instructions. Mark the live capability not configured or not verified. Do not return fake success or hide failures.

Add a server-side launch-readiness check. Live payment collection cannot be enabled while accepted terms, jurisdiction/tax configuration, real expert coverage, privacy configuration, and actual provider credentials are missing. This is a product control, not a reason to stop local implementation.

Prepare integrations for real operation, but do not purchase services, register domains, deploy publicly, charge cards, contact prospects, or connect client systems as part of this assignment without explicit authorization. Finish the concrete reviewable release package first.

## 8. Milestones

### M0 — Project and contract

Inspect and document the repository, confirm scope, establish the configuration and data model, and create a practical implementation checklist. Then proceed directly to implementation.

### M1 — First complete journey

An accepted demo member signs in, selects any supported role, sees the common foundation and honest branch readiness, reads a lesson, submits private evidence, receives feedback from an assigned reviewer, and revises their work. Demonstrate ownership and reviewer-access controls.

### M2 — Private MVP

Complete text mock practice, the workflow library, coaching booking and capacity, subscription phases, entitlement ledger, payment test events, member terms/invoices, operator workflows, export/deletion, and useful instrumentation. Provide seeded scenarios and a repeatable reset for development data.

### M3 — Verification and pilot preparation

Run the acceptance journeys below, inspect desktop/mobile and keyboard access, prepare the pilot delivery pack and launch checklist, resolve defects, and report actual readiness. Do not mark live AI, payment, email, or calendar operation verified if only the test adapter ran.

### Later roadmap, document only

Voice practice; expanded reviewed role/domain packs; optional native calendar and learning integrations; selective Specialist/Practice offers; controlled hosted agent execution; and a separately validated Partner managed service. Employer and staffing-agency accounts remain future work. Do not change the individual-first business model to make the upper price easier to sell.

## 9. Required acceptance journeys

1. **All-role access and honest coverage:** a cybersecurity member and a business-analysis member can both apply and use the shared foundation. A branch without qualified coverage cannot sell tailored review. A demo expert does not satisfy live readiness.
2. **Private assessment:** member A uploads and revises evidence; assigned reviewer publishes feedback; member B and an unassigned coach cannot read it. Revoking the reviewer stops subsequent downloads, including through an old link after its short expiry.
3. **Booking and quota concurrency:** two simultaneous attempts for the last slot/credit yield one success and one clear, recoverable failure. Staff cancellation restores the correct dated credit without erasing history.
4. **Pilot conversion:** a CAD 3,000 pilot followed by a timely accepted CAD 9,000 continuation yields twelve total service months anchored at the pilot start, correct remaining monthly grants, and no duplicate charge or grant. A non-converter is not charged. Late acceptance cannot activate the standard continuation or bill missed service; it requires an explicitly accepted replacement agreement. Direct annual enrollment and a later renewal use their own correct phases.
5. **Payment disorder:** duplicate and out-of-order payment events are idempotent; stale events cannot overwrite a newer paid state; refunds and early-release decisions produce an auditable result. Reconciliation exposes exceptions.
6. **AI reliability and budget:** role-specific interview feedback links to member responses; insufficient evidence is explicit; malicious uploaded instructions cannot access other workspaces or tools; provider timeout/malformed output restores or settles the correct usage reservation and is shown honestly.
7. **Content and template versions:** a revised rubric does not change a completed assessment. A retired or unverified template is not presented as currently supported. Downloads and sample tests work for the declared version.
8. **Privacy and deletion:** exports include only the requesting member's permitted records; revoked sharing stops access; a deletion request removes the configured active and derived material while accurately reporting any separately retained billing/backup records.
9. **Commercial truth:** demo payments and seed outcomes are excluded from production metrics. Higher tiers cannot be purchased without publication, capacity, and scope. Pricing, quotas, and terms shown at acceptance match the offer version stored with the agreement.
10. **Usability and recovery:** the core journey works at narrow/mobile widths, with keyboard navigation, labels, readable validation, empty/error/loading states, and page-reload recovery. No non-functional button is presented as a completed feature.

Use meaningful unit/integration tests for money, dates, ownership, quotas, state transitions, and AI result validation. Use browser end-to-end tests for the journeys that cross modules. Avoid large suites that merely reproduce trivial implementation details. Once appropriate tests pass, widen testing only for new changes or unresolved risk.

## 10. Commercial context to preserve

The annual price hypotheses have no paid validation yet. The first pilot target is five paid members across multiple roles; four useful assessed completions and three paid continuations are proposed initial decision gates, to be replicated before scaling. The founder must verify channels, experts, and customer benefit.

The initial financial model includes only the CAD 3,000 pilot and Professional continuation. Its illustrative Base case has 37 paid pilot starts, about CAD 159,768 of earned service revenue, CAD 206,468 net collections, and an approximately CAD 59,798 operating loss in year one after modeled acquisition and central expenses. Approximately CAD 46,700 of closing collections relate to undelivered service. These figures are assumptions-based examples from the accompanying model, not traction or marketing copy. Do not publish them as actual results.

The same Base case implies approximately CAD 80,840 of opening funding when all prepaid service receipts are protected and a CAD 15,000 operating buffer is maintained. This is a modeled scenario, not approved spending or a verified funding requirement. Stage actual expenditure around paid-pilot evidence and the owner's real budget.

The model's proposed loaded expert costs and service limits are operational budgets, not evidence of available staff or provider prices. Actual costs must be measured. The CAD 120,000 Partner service is a future bespoke offer and must not be included as necessary revenue to justify the MVP.

## 11. Final delivery requirements

Deliver the working application and:

- Clear local setup and test instructions, environment example, migrations, seed/reset commands, and demo accounts restricted to the demo environment.
- A concise list of implemented features and known limitations mapped to the backlog.
- Validation evidence for critical logic and actual browser journeys, with the source revision or working-tree snapshot and test environment identified.
- Separate status for demo, configured live adapters, verified live operation, private deployment, and commercial launch.
- The eight-week pilot delivery outline, staff operating procedures, and remaining launch decisions.
- A release checklist, rollback/backup procedure, and the next implementation milestone.

Use the user's existing model settings; do not assume this prompt authorizes selecting paid products or changing their account configuration. Keep progress updates concise and focused on findings, decisions, and remaining uncertainty. Continue through routine fixes until the requested private MVP and its verification are complete. If an external dependency blocks one part, finish the independent work and state the exact unresolved dependency with a prepared next step.

Start now by inspecting the active project, recording a short implementation plan, and building the first complete member-to-reviewer journey.
