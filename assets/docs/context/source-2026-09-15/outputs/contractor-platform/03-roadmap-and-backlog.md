# Contractor Success Platform — Roadmap and Build Backlog

**Version:** 1.0 · **Planning date:** 15 September 2026 · **Currency:** CAD, before applicable taxes

**Companion specification:** [Business plan](01-business-plan.md). This file defines the product implementation and acceptance criteria. Commercial promises and allowance changes must be reconciled with the business plan and financial model before they are offered to members.

## Status and product boundary

This is an implementation proposal, not a claim of customer demand, legal approval, integration availability, or completed software. All CAD prices and allowances are hypotheses to validate. The initial paying customer is one independent IT contractor. Every member starts in a private individual workspace; supporting agencies and employer accounts is deferred.

The product promise is: help an experienced contractor choose a valuable development path, practise realistic work, produce credible evidence of capability, and keep improving through expert feedback and useful workflows. Do not promise placement, income, certification, client approval, or an interview pass.

Initial offers:

- CAD 3,000 for the first two billing months, with eight instruction weeks. Start with five members across the eligible IT-role taxonomy and confirm expert coverage for each promised tailored service. Use the pilot to validate demand, delivery effort, skill assessment, and continuing membership purchase.
- On explicit conversion, CAD 9,000 buys the remaining ten months of the first membership year, paid upfront or in ten CAD 900 instalments. Total first-year price is CAD 12,000. Do not collect a fresh CAD 12,000 in addition to the pilot fee or silently auto-convert a pilot.
- The Professional CAD 12,000/year membership renews for twelve months. A direct annual start can be CAD 12,000 upfront or CAD 1,000/month on a twelve-month term. Instalment billing is not automatically a cancel-anytime offer. Early termination and refund handling remain operator workflows governed by reviewed terms rather than assumed legal conclusions in code.
- Specialist CAD 24,000, Practice CAD 48,000, and Partner CAD 120,000/year: provisional higher service levels. Display as application/inquiry options only when scope, staffing, and a customer-specific business case exist. Do not make these checkout products in the MVP.

Serve all IT contractors from the initial positioning and enrollment. The role taxonomy includes software development, QA/testing, data/analytics/AI, cloud/DevOps/platform, cybersecurity, architecture, business analysis, project/program/delivery management, product ownership/product management, and other IT specialties with a manual fit review. Members may choose more than one role. Do not narrow marketing or admissions to developers and QA.

Build a shared foundation for all roles, then role-specific branches. Every branch has an explicit readiness state: available, limited coverage, in preparation, or retired. Available requires reviewed material and bookable advertised expert coverage. Limited coverage names the available scope; in-preparation content cannot be sold as delivered; retired versions remain available only for authorized historical records. Readiness covers available material, assessment validity, and human expert coverage, not merely whether a page exists. All roles can use the initial assessment and common foundation; sell tailored coaching or domain-specific assessment only after the promised expert coverage is confirmed. Initial fuller pathways can cover software/QA and business-analysis/delivery while other members receive accurately described foundation services and covered individualized work. Additional roles and domains are content expansion, not new hardcoded applications.

## Personas and access

| Persona | Work they need to perform | Allowed scope |
|---|---|---|
| Prospective member | Understand fit, compare the live offer, apply, inspect a truthful sample | Public material and explicitly public samples |
| Member | Plan learning, practise, submit evidence, receive reviews, book support, inspect usage and billing | Their own workspace and published member content within their offer |
| Coach | Review goals and sessions; provide feedback | Only assigned members, relevant goals, explicitly shared submissions, and their own session notes |
| Domain reviewer | Assess a particular project against a published rubric | Assigned submission version and minimum profile context required for that assessment |
| Content editor | Draft, revise, and release learning material and templates | Content system; no member evidence by default |
| Operations administrator | Allocate delivery work, resolve bookings and membership problems, manage offers | Operational metadata; member content only through a logged support-access workflow |
| Platform administrator | Manage infrastructure and integrations | Separately assigned privileged role; audited access and no routine browsing of member evidence |

Coach and reviewer grants must have a purpose, start, expiry, and revocation. Being a coach does not confer access to every member. Member-facing notes and internal operational notes must be visibly distinct. A revoked assignment must also invalidate later evidence downloads. Workspace owners cannot grant themselves staff roles.

## Core member journeys

### 1. Join and establish a baseline

Public offer → fit application → human approval for the limited founding cohort → test-mode checkout or recorded pilot agreement → private account → structured onboarding → baseline exercise → reviewer feedback → agreed learning plan.

Onboarding records current experience, chosen roles, target domain, available weekly hours, learning objectives, and evidence-sharing preferences. Every IT role can onboard and receive the common foundation. The plan shows actual branch readiness and any expert-coverage condition before paid tailored services are committed. Financial targets and contract dates are optional and private. Do not request full client contracts, identity documents, private repositories, or client credentials.

Use an authentic baseline task and plain feedback. A model may draft observations linked to the submitted work. Only an approved evaluator can publish a formal assessed result. Mark self-reported experience as self-reported, AI suggestions as suggestions, and human-reviewed results with reviewer, rubric version, date, and evidence.

### 2. Learn, apply, and demonstrate

Learning plan → short material → realistic exercise with synthetic data → local or uploaded project artifact → member confirms permission to share → AI draft feedback if enabled → human review → revision → member-controlled portfolio summary.

Pin the content and rubric versions used for each assignment. An update cannot silently alter a completed member's assessment. A portfolio summary must distinguish work completed in a simulation from paid client experience. All public sharing starts off and requires a deliberate member action.

### 3. Practise an interview

Choose available scenario → show format, allowance use, and recording policy → start text session → ask role/domain-specific questions → allow follow-up questions grounded in the member's answers → produce cited observations and a practice plan → optionally request an expert review.

MVP uses text to reduce cost, integration work, and recording complexity. The score is an explicitly labelled practice indicator, with criteria and uncertainty. If answers are too sparse, return “not enough evidence” instead of a numerical score. Do not claim a validated hiring prediction, personality assessment, or certified proficiency. Voice/video comes later with separate recording consent and deletion controls.

### 4. Book and receive support

Show eligible support types and member allowance → show real available coach slots → hold a slot briefly → atomically reserve slot and entitlement → confirm inside the platform → conduct session via a manually configured meeting link → publish agreed action notes → settle the entitlement.

One slot cannot be booked twice. Operations can move a booking only through a logged change that releases and re-reserves capacity. Cancellation rules and deadline timezone are visible before confirmation. Refund of an allowance follows the configured policy; cancelled records remain in history. Do not claim that an external calendar invitation or email has been sent when the configured provider is absent.

### 5. Use an agent workflow

Browse approved template → inspect purpose, tools, input classification, costs, tests, version, and limitations → copy/download or run in an isolated permitted environment → verify outputs using the included checklist → submit private feedback.

MVP templates are downloadable, versioned bundles using synthetic examples. They do not connect to a member's client systems or execute arbitrary actions from the web platform. A later hosted execution feature needs its own permission, isolation, network, retention, and spend design. The template record must state when it was tested and with which provider/model/runtime versions.

### 6. Continue during an assignment

Monthly goal check → learning or delivery problem described using permitted/anonymized material → relevant scenario or expert support → recorded next actions → optional renewal preparation before a member-entered assignment end date.

This supports retention after a job search ends. It is advisory preparation, not access to client systems, managed delivery of client projects, legal contract review, or automated outreach. The member decides what to send to a client.

## Offer entitlements and capacity

Keep entitlements in versioned offer data, never scattered across UI conditionals. The following implements the agreed planning package. These prices and quantities remain commercial hypotheses; any revision before sale must update the business plan, configuration, and economic model together. Existing paid agreements preserve their promised terms.

### Annual plan configuration

| Plan | Annual fee | Monthly individual service capacity | Monthly AI allowance | Availability |
|---|---:|---|---|---|
| Professional | 12,000 | 60 minutes coach, 30 minutes domain/project review, 30 minutes support | 20 text mock sessions and 100 study requests | Pilot first; annual paid beta after gates |
| Specialist | 24,000 | 120 minutes coach, 60 minutes domain review, 60 minutes implementation support, 60 minutes support | 40 text mock sessions and 200 study requests | Future; application and capacity gate |
| Practice | 48,000 | 180 minutes coach, 120 minutes domain review, 180 minutes engineering, 120 minutes support | 60 text mock sessions and 300 study requests | Future; individual business case |
| Partner | 120,000 | 240 minutes coach, 120 minutes senior advisor, 240 minutes domain review, 720 minutes engineer, 480 minutes analyst, 240 minutes support | Negotiated contractual maximum | Future; custom statement of work |

All plans include eligible published shared learning and role paths, assessed progress records, the applicable maintained workflow library, and four pooled one-hour clinics per month. Each clinic group is capped at 16 members. Do not convert four group hours into four private coaching hours per member or schedule extra domain clinics without funded expert coverage.

Each Professional 60-minute coaching unit contains one 45-minute call and 15 minutes of preparation/notes. A human mock interview uses this coaching allocation; it is not an additional free service. Each Professional 30-minute review contains approximately 20 minutes of review and 10 minutes of preparation. Higher-tier time budgets also include preparation, reading, notes, and follow-up. Support minutes pay for scoped support work, not unlimited technical resolution. Model individual hours in whole minutes so allowances and recorded costs reconcile precisely.

AI text mock sessions have at most 30 turns. Study requests and interview turns also have server-side token, document-size, concurrency, and cost limits. Initial monthly AI cost assumptions are CAD 25/45/100/250 for Professional/Specialist/Practice/Partner; these are unverified budgets to measure. An exhausted spend budget cannot silently remove a promised paid entitlement: offer an explicit service-recovery path while operations resolves the mismatch. Do not issue automatic overage charges.

### Pilot and first-year conversion

The standalone CAD 3,000 pilot covers the first two billing months and eight instruction weeks. Its explicit human package is **two coaching calls, each with 45 minutes of contact plus 15 minutes of preparation, and four scoped 30-minute project reviews, each including preparation**. This is a total of two coach hours and two review hours across the pilot. It also includes 60 support minutes per billing month, the shared foundation, one covered role-specific practical assignment, pooled clinics, and the small tested workflow library. Reserve an additional one-time 60 coach minutes and 30 support minutes for onboarding in the operating cost and capacity model. This onboarding reserve is not an extra member purchase. Continuing Professional support returns to 30 minutes per month. Baseline and closing feedback must fit funded activities; do not add invisible uncosted expert sessions.

Pilot AI allowance equals Professional: 20 text mock sessions and 100 study requests per billing month. Across the two pilot billing periods, that is at most 40 mock sessions and 200 study requests, with the monthly reset and failure-restoration rules. A human mock interview replaces a coaching call within the coaching allocation.

Onboarding covers the baseline conversation, permissions, and initial plan. The first regular coaching call covers development planning; the second covers closing review and next-quarter actions. The four project reviews cover baseline work, first draft, revision, and final assessment. Each reviews an agreed artifact section against up to three criteria within the allocation. Do not create an additional unfunded closing meeting. Before continuation, show the reduction from two reviews and 60 support minutes monthly in the pilot to one 30-minute review and 30 support minutes monthly; record intended continuing use and check usefulness after 90 days.

On explicit continuation accepted by the end of the second billing period, grant the remaining ten months of Professional service from the start of month three for CAD 9,000, either upfront or ten CAD 900 instalments. A late return requires a separately priced manual agreement with explicit dates and credit treatment, not retroactive charges or grants. Those ten months grant ten monthly Professional bundles: ten coaching units, ten 30-minute review units, ten 30-minute support units, and the stated monthly AI and clinic access. Pilot consumption stays in history. The first year therefore contains twelve bookable coach hours and seven review hours including the pilot's four-review package; the operating model additionally reserves the one-time onboarding coach hour. The enhanced pilot review allocation is intentional, not a second annual bundle.

An annual membership year and billing month are anchored to the original activation date. Specify an end-of-month policy for dates such as January 31. Eight instruction weeks do not redefine two billing months. Conversion starts month three and ends at the original first anniversary. Direct annual Professional is CAD 12,000 prepaid or twelve CAD 1,000 instalments; renewal starts a new twelve-month service term at the then-accepted disclosed price. Future annual instalment equivalents are CAD 2,000/4,000/10,000 for Specialist/Practice/Partner. Instalments do not imply cancel-anytime membership.

### Booking, expiry, and operating rules

- Show the monthly allowance, preparation portion, service scope, real qualified availability, cancellation deadline, and local timezone before confirmation.
- Proposed rescheduling window: at least 24 hours. No-show consumption follows the disclosed policy. Platform cancellation restores the relevant credit and offers replacement availability.
- Expert hours normally expire at the end of the billing period. Provider-caused unavailability creates a dated replacement credit; a generic no-rollover rule must not erase the service-recovery obligation.
- Annual prepayment does not unlock all future monthly appointments or AI allocations immediately. An explicit approved offer can vary this, but the change must be versioned and costed.
- A standard review has a declared scope/artifact size. A resubmission consumes an applicable review allocation unless its agreement explicitly provides otherwise. Do not imply unlimited revisions.
- Human add-ons are explicitly quoted and accepted, not automatically charged or silently debited from another service category.
- Professional support acknowledgement target: two business days. Specialist/Practice: one business day during staffed hours. Partner: negotiated coverage. Acknowledgement is different from resolution.
- Default staffing: Monday–Friday, 09:00–17:00 Eastern time, excluding the published holiday calendar; display equivalent member-local times. Remote delivery does not imply round-the-clock service.
- Group recordings require applicable participant consent; provide a written summary when recording is unsuitable.
- Cancellation-at-term-end is visible. Early release, hardship, provider failure, dispute, and refund requests follow an operator-reviewed policy with recorded reasons and reviewed jurisdiction-specific terms. Do not present draft terms as a legal conclusion.

Show both remaining allowance and available provider capacity. Before accepting payment, reserve forecast capacity by expert specialty and service category, including preparation, QA, support, and scheduling slack. The scarcest qualified service limits admission. One generalist account cannot establish senior expert coverage for every IT role.

## Screen map and thin first release

The list below is the target screen map, not twenty separate screens required in the first coding slice. The first slice combines public offer/application, member home/onboarding, pathway/assignment/review, member settings, and the assigned staff worklist. The full Phase B private MVP then adds template library, booking/usage, AI text practice and study help, member opportunity/renewal tracking, test billing with a manual provider adapter, privacy operations, and the minimum operator views. No external API subscription is required: deterministic adapters must exercise the full state flow and be labelled test/demo. A manually recorded agreement and payment event can support founder operations, but it must retain actor, evidence, date, and audit history rather than masquerading as a provider-verified payment.

Build one complete vertical slice first: accepted member → common foundation → private submission → assigned human reviewer → published feedback. Demonstrate its authorization and evidence controls before adding billing state, AI practice, and operations. These additional functions remain required for full Phase B completion; finishing the first slice alone is not a completed private MVP. Do not create empty navigation or database modules as a substitute for this journey.

Public:

1. Home: all-IT-contractor positioning, supported role taxonomy, shared foundation, accurate branch readiness, practical outcome, honest sample, and application action.
2. Live offer: CAD price, duration, taxes handled as configured, exact allowances, scheduling rules, cancellation terms, and outcome boundaries.
3. Application and acceptance status.
4. Sample pathway/project using clearly labelled demonstration content.

Member:

5. Onboarding and permission preferences.
6. Dashboard: next action, pathway progress, upcoming session, and current allowance balances.
7. Learning plan and lesson/exercise reader.
8. Assignment and evidence upload with sharing scope, file status, and version history.
9. Review and revision view with rubric criteria and evidence-linked feedback.
10. Text interview practice and results history.
11. Agent template catalog and version detail.
12. Coaching availability, bookings, cancellation policy, and shared notes.
13. Goals and optional assignment/renewal dates.
14. Membership, usage history, invoices, renewal/cancellation state, and support request.
15. Privacy/export/delete request controls and active sharing grants.

Staff:

16. Assigned-member queue and review worklist.
17. Capacity calendar and booking exceptions.
18. Content/rubric/template draft, preview, publish, and retire workflow.
19. Applications, subscriptions, payment events, and operational audit view.
20. AI configuration, cost limits, job failures, and evaluation results.

Do not expose empty navigation sections implying future features work. Hide deferred screens or label a non-interactive roadmap explicitly.

## Architecture and implementation decisions

First inspect any repository supplied by the user, its instructions, existing authentication, payments, design system, infrastructure, and tests. Extend healthy existing patterns instead of replacing them. Do not assume access to the user's other repositories or copy their course assets without confirming usage rights.

If no repository is supplied, create one coherent TypeScript application using Next.js, PostgreSQL, a migration-capable database layer, private object storage, and a background job runner. Choose exact maintained packages after checking their official documentation at implementation time. Keep the initial deployment as a modular application rather than separate microservices.

Logical modules:

- Identity and workspace access.
- Offer catalog, agreements, subscriptions, and billing events.
- Entitlements and service capacity.
- Learning content and assessed projects.
- Interview practice and AI orchestration.
- Template registry.
- Coaching, reviews, and shared notes.
- Notifications, audit, privacy requests, and operational metrics.

Use adapters for authentication, payments, object storage, AI provider, calendar, email, and analytics. A demo adapter uses deterministic synthetic fixtures and marks the whole environment as demonstration mode. The live adapters must remain disabled until configuration passes validation. No dummy “success” response may stand in for a missing integration. Demo jobs and payment events cannot change production data; environments use separate databases, buckets, keys, and webhook secrets.

A background job stores its own status, attempts, idempotency key, provider request identifier if available, and sanitized error. Long AI requests and notifications should survive page reloads. Observability must avoid raw evidence, tokens, prompts containing personal data, or payment details in logs.

## Relational data model

All member-private records carry `workspace_id`; foreign keys or equivalent validated relationships prevent linking records across workspaces. Staff assignment is an explicit access relationship. Published content is global or catalog-scoped and is separated from member data. The following is the target logical model: create migrations for the current vertical slice, not every future table in the first commit. Combine entities where doing so preserves the listed invariants and simplifies implementation.

| Area | Principal records and essential fields |
|---|---|
| Identity | `users`, `workspaces`, `workspace_memberships`, `staff_roles`, `staff_assignments`, `access_grants`; grant purpose, scope, expiry, revoked timestamp |
| Role/domain taxonomy | `roles`, `member_roles`, `domains`, `competencies`, `pathway_readiness`, `expert_coverage`; stable identifiers, published descriptions, branch readiness, covered service types and dates |
| Commercial catalog | `offers`, `offer_versions`, `entitlement_definitions`, `offer_entitlements`; CAD minor-unit amounts, billing period, published terms version |
| Purchase and membership | `applications`, `agreements`, `orders`, `subscriptions`, `subscription_phases`, `subscription_events`, `invoices`, `payment_events`; provider references, original membership-year anchor, pilot/conversion/renewal phases, instruction-week dates, independent service-access dates, cancellation-effective date |
| Allowances | `entitlement_accounts`, `entitlement_ledger`, `reservations`; unit type, integer quantity, grant period, expiration, related booking/job/review, immutable event key |
| Capacity | `staff_service_types`, `availability_rules`, `availability_exceptions`, `slots`, `bookings`, `booking_events`, `clinic_groups`, `clinic_sessions`, `clinic_enrollments`; UTC timestamps, display timezone, hold expiry, concurrency guard |
| Learning | `pathways`, `pathway_versions`, `content_items`, `content_versions`, `source_references`, `enrollments`, `lesson_progress`, `learning_plans` |
| Assessment | `assignments`, `assignment_versions`, `rubrics`, `rubric_versions`, `submissions`, `submission_versions`, `evidence_objects`, `review_assignments`, `reviews`, `review_criteria`, `appeals` |
| Interviews | `interview_scenarios`, `scenario_versions`, `practice_sessions`, `practice_turns`, `study_requests`, `feedback_runs`; evidence references, result status, evaluator/model version |
| Templates | `templates`, `template_versions`, `template_test_runs`, `compatibility_records`, `template_feedback`; source/license, maintained status, known limitations |
| Advice | `goals`, `member_assignment_dates`, `session_notes`, `action_items`, `opportunities`, `service_time_entries`; note visibility and member approval where needed |
| AI operations | `ai_policies`, `ai_jobs`, `ai_usage_events`, `ai_budget_reservations`, `evaluation_cases`, `evaluation_runs`; provider, model, input class, token/use estimate and actual cost |
| Trust and operation | `consents`, `audit_events`, `notification_outbox`, `privacy_requests`, `deletion_jobs`, `support_requests` |

Separate application status, payment status, and service-access status. Examples include accepted-but-unpaid, active service with a payment dispute requiring review, cancelled-at-period-end with remaining service access, and a completed pilot with read-only evidence export. Do not compress these into one `isActive` boolean.

Invoices are snapshots of ordered offer terms and quantities. Store monetary values as integer minor units, never floating point. Provider invoice links are returned only to an authorized member. Tax rates and applicability are configured through reviewed billing settings or a properly configured tax provider; do not hardcode a universal Canadian tax assumption.

### Entitlement ledger rules

1. Append grant, reserve, consume, release, expire, and adjustment events. Never rewrite historical usage to fix a balance.
2. Every command has an idempotency key and a correlation to its booking, assessment, or AI session.
3. Atomically check balance and reserve; parallel requests must not overspend one remaining unit.
4. A completed service consumes its reservation. A provider failure releases it unless the disclosed policy identifies a delivered partial service.
5. A timeout must be reconciled against provider state before another expensive request is sent.
6. Cancellations produce compensating entries, preserving the original grant and activity trail.
7. Materialized balances may accelerate display, but the ledger is authoritative and must reconcile.
8. A plan change creates a new effective offer version and explicit grants/adjustments. It must not retroactively relabel prior services.

## Payment behavior and launch boundary

Implement a configured payment adapter in test mode before enabling sales. Persist and verify signed webhook events; reject invalid signatures; deduplicate provider event IDs; tolerate out-of-order delivery by reconciling provider state rather than blindly applying timestamps. Never grant paid access based solely on a successful browser redirect.

Test successful payment, duplicate and delayed delivery, failed renewal, payment recovery, scheduled cancellation, immediate service cancellation where permitted, refunds, and disputes. The access treatment for each event must be an explicit policy, not guessed inside handlers. A retry cannot create a second order or duplicate entitlement grant.

No real charges, paid account creation with a provider, domain purchase, production email, published client-facing site, or live external calendar invites are needed to complete the initial build. Prepare the concrete test-mode result and configuration instructions first. A later explicit instruction to launch authorizes the configured launch actions within its scope.

## Evidence security and AI controls

- Uploads default to private. Use allowlisted types, size limits, malware/quarantine status, and private storage. An upload is unavailable for review until validation completes.
- Access is checked on every evidence request. Use short-lived signed delivery links and do not treat knowing an object key as authorization. Delete or expire outstanding shares when required; do not place storage URLs in public analytics or logs.
- Members confirm they own or have permission to submit material. Teach use of synthetic or properly anonymized examples; never invite client credentials, production records, or confidential source code as standard onboarding.
- Sending evidence to an external AI provider requires a recorded purpose and sharing choice that names the provider boundary. “No AI review” leaves human review available where included. No model training or reuse of private member work is implied by membership.
- Start with no agent tools that can send email, change repositories, spend money, or access client systems. Treat uploaded documents and retrieved material as untrusted content, not instructions.
- Use schema-validated model output, evidence citations, input and output length caps, approved models, per-request and per-workspace cost caps, global budget alerts, concurrency limits, and a stop switch.
- Reserve an estimated AI budget before dispatch and reconcile actual usage afterward. If a provider omits actual cost, mark the cost estimated; never display an exact invented total.
- Store model/prompt/rubric versions with feedback. Separate model-generated feedback from human-approved assessment.
- Publish source, author/reviewer, version, last review date, license/usage permissions, and limitations on content and templates. Flag stale compatibility rather than quietly implying support.
- Privacy export and deletion workflows include object storage, search indexes, AI logs retained by the platform, shares, and derived artifacts. Explain backup and third-party retention accurately. Do not promise instantaneous universal deletion.

## Phased roadmap and stage gates

The phases match the business plan. Timings are planning ranges for a founder with consistent product attention, AI coding assistance, and available expert reviewers. They are not fixed delivery commitments.

| Phase | Indicative timing | Work and completion gate |
|---|---|---|
| A — Define and demonstrate | Weeks 1–2 | Agree the offer, common foundation, role briefs, sample rubric, rights, expert roster, and capacity. Show a private prototype. Gate: scope and delivery capacity are reviewable, and no unavailable expertise is advertised. |
| B — Private MVP | Weeks 3–6 | Complete the full member/coach/operator journey with deterministic adapters, text AI practice, study help, test billing/manual provider records, privacy controls, and truthful readiness labels. Gate: all applicable acceptance journeys pass in the browser; demo outcomes are never represented as live. |
| C — First paid pilot | Weeks 7–14 | Admit five paying members across multiple roles; deliver eight instruction weeks within two explicit billing periods; measure costs, reviewed work, and support. Gate: real launch prerequisites are complete, capacity is reserved, and obligations are fulfilled. |
| D — Paid continuation | Weeks 15–20 | Offer explicit CAD 9,000 continuation, operate recurring service and billing, maintain workflows, and improve covered role paths. Gate: paid continuation and workable delivery economics; a survey alone is insufficient. |
| E — Repeatability | Months 6–9 | Repeat cohorts, strengthen expert backup/support, improve acquisition, and optionally test Specialist. Gate: repeated buying behavior, useful ongoing service, funded qualified capacity. |
| F — Selective expansion | Months 10–12+ | Test Practice and later Partner with individual business cases; expand countries/languages only where ready. Gate: separate buyer evidence, staffing, legal/operating preparation, and economics for each expansion. |

### P0 implementation order inside Phase B

1. **Testable slice:** repository decision, versioned offer/taxonomy, test fixtures, identity, private evidence, one lesson/assignment, and assigned human feedback. Complete the accepted-member → common-foundation → submission → review journey first. Use synthetic data.
2. **Full private MVP:** add the immutable ledger, actual booking capacity, workflow catalog, AI practice/study gateway, test/manual billing and phase conversion, clinics, member-owned opportunity/renewal record, support time, privacy operations, and basic service/cost reconciliation.
3. **Release verification:** run the stated end-to-end journeys, inspect representative desktop/mobile views, exercise a restore, document failed or disabled external adapters, and deliver a private release package. Do not call the first slice a complete Phase B MVP.

All Phase B features must work through honest local/test adapters without requiring purchased external services. Live-provider integration, a live model, or live payment execution may remain disabled until configured; the underlying full workflow must still run in deterministic test mode. An AI simulation must visibly say it is simulated and cannot publish a real assessed skill result. A manual payment record must visibly identify its human recorder and evidence status.

Commercial Phase C cannot be inferred from Phase B completion. The five-pilot gate is five actual purchases, at least four useful reviewer-accepted assignments, and at least three actual purchases of the ten-month continuation before confidently retaining the Professional offer. A sample of five is directional; replicate before claiming repeatability.

## Implementation-ready issue backlog

These are local issue specifications, not already-created GitHub issues. The implementation agent may convert them to project issues when that repository action is authorized. Every implementation issue records its phase, dependency, acceptance evidence, and excluded scope. Keep commits reviewable and preserve unfinished work from other contributors.

| ID | Issue and dependencies | Acceptance criteria |
|---|---|---|
| CTP-001 | Audit project and record architecture decisions. No dependencies. | Read project instructions; inventory reusable auth, design, billing, tests, and owned content; record reuse/greenfield decision and exact tools chosen from current official docs. No unrelated repository changes. |
| CTP-002 | Encode commercial catalog, terms, and subscription phases. Depends 001. | Professional/Specialist/Practice/Partner prices and service-minute quotas match the business plan. Pilot grants two 60-minute coaching units and four 30-minute review units across two billing periods, plus stated support/AI. CAD 3,000→CAD 9,000→CAD 12,000 phases preserve anniversary. Only approved live offer is purchasable; higher plans are applications. |
| CTP-003 | Implement all-role taxonomy, readiness, and expert registry. Depends 001. | All nine named IT role families plus other specialty can register; multi-role choice works. Available/limited coverage/in preparation/retired states display accurately. Expert role/domain, service types, dates, costs, and backup coverage are recorded. No unsupported tailored service can be committed. |
| CTP-004 | Create deterministic adapters and configuration validation. Depends 001. | Synthetic seed includes two members, multiple roles, an assigned/revoked coach, reviewer, editor, and operator. AI/payment/storage/calendar/email adapters separate demo/test/live modes. Missing live settings produce actionable disabled states; no fake sent message or live payment confirmation. |
| CTP-005 | Implement identity, workspace authorization, and staff grants. Depends 001, 004. | Members own private workspaces. Coach/reviewer access is assignment-scoped and time-bounded; editor role grants no member-data access. Direct API requests cannot bypass boundaries; revocation prevents new access; privileged support access is logged. |
| CTP-006 | Implement evidence consent, private upload, and quarantine. Depends 005. | Allowlisted size/type rules, malware/quarantine state, sharing permission, and private object storage work. Invalid objects cannot reach review. Every download rechecks authorization; short-lived links, metadata/log redaction, and deletion hooks are verified. |
| CTP-007 | Implement versioned content, sources, rubrics, and publication. Depends 003, 005. | Draft/preview/review/publish/retire workflow is real. Each available item has owner, sources/rights, review date, supported role/domain, and version. Assessments pin rubric/content versions; new releases do not rewrite earlier results. |
| CTP-008 | Implement application, covered offer acceptance, and baseline plan. Depends 002, 003, 005, 007. | All roles can join the common foundation. Prospect sees exact covered scope and capacity before acceptance/payment. Self-reported experience remains labelled. Baseline and 90-day plan fit funded human services; no fabricated credential or fixed coding test for noncoding roles. |
| CTP-009 | Implement lesson reader, progress, and assignment selection. Depends 007, 008. | A member reads actual accessible material/transcript, completes an exercise, and sees accurate next actions. Role-appropriate assignment is selected. Progress reflects observed activity/completion, never synthetic earnings or hiring outcomes. |
| CTP-010 | Implement submission versions, human review, and revisions. Depends 006, 009. | Qualified assigned reviewer sees only the authorized version, records criterion-level feedback with evidence references and time spent, and publishes a review. Revision creates new evidence; prior feedback remains intact. Simulated assignments stay labelled in any portfolio output. |
| CTP-011 | Implement immutable entitlement reservations and ledger. Depends 002, 005. | Grant/reserve/consume/release/expire/adjust events use idempotency keys and immutable history. Atomic checks prevent overspending. Whole-minute human budgets include preparation; separate categories never silently substitute. Pilot/continuation/month-end grants reconcile without a duplicate annual bundle. |
| CTP-012 | Implement expert capacity, booking, and policy exceptions. Depends 003, 005, 011. | Local timezone availability shows qualified slots. Concurrent booking has one winner; booking reserves service and capacity atomically. The 24-hour proposed window/no-show/provider-cancel policies behave as disclosed. Provider-caused failure issues a dated replacement credit and logs both histories. |
| CTP-013 | Implement maintained workflow registry and downloads. Depends 007. | Published bundles have setup, synthetic inputs, expected outputs, tests, permission/cost limits, version compatibility, license, owner, and last verification. Retired/stale versions warn accurately. Downloading does not execute code or connect to a client system. |
| CTP-014 | Implement AI gateway, consent, token/cost budgets, and jobs. Depends 004, 005, 011. | No sharing consent means no dispatch of private evidence. Approved models, input limits, queue/concurrency, idempotency, cost reservation/reconciliation, and kill switch work. Timeout ambiguity is reconciled before costly retry. Estimated cost is labelled; platform failures restore allowances. |
| CTP-015 | Implement text mock interviews and study assistance. Depends 007, 014. | Professional/pilot: 20 mocks and 100 study requests per billing month; Specialist: 40/200, Practice: 60/300, Partner configured contract max. Mocks capped at 30 turns; feedback cites actual responses and marks insufficient evidence. Study answers use eligible versioned sources. Deterministic demo is visibly simulated; live mode disabled until configured. Human mock requires coach quota. |
| CTP-016 | Implement test billing and manual-provider payment events. Depends 002, 004, 005, 011. | Signed provider events are validated; duplicate IDs grant once; delayed/out-of-order events reconcile. Redirect alone never grants access. Manual receipt records actor/date/evidence/status and cannot claim independent provider verification. Test success/failure/refund events update immutable invoice and service records correctly. |
| CTP-017 | Implement continuation, renewal, cancellation, and invoice views. Depends 016. | Standalone pilot never auto-converts. Explicit CAD 9,000 purchase starts month 3 and ends at original anniversary. Ten CAD 900 instalments or upfront schedule works; direct/renewal Professional uses twelve CAD 1,000 instalments or CAD 12,000. Term-end cancellation is visible; early release/refund/dispute is operator-reviewed. Tax remains separate and configured. |
| CTP-018 | Implement member-owned opportunity, renewal, and goal tracker. Depends 005, 008. | Member records an opportunity or contract date, approved evidence, next action, and local reminder. It is not a supplied-job marketplace. Draft client/proposal/renewal text needs member approval and remains unsent; no automatic external outreach. |
| CTP-019 | Implement staff worklist, support allowances, and time capture. Depends 010, 012, 017. | Assigned queue shows review age, bookings, allowed scope, and available expert time. Preparation/review/notes/support time counted once against category budgets and costs. Acknowledgement target differs from resolution; uncovered work goes to a quoted or coverage-review path. |
| CTP-020 | Implement pooled clinics and attendance. Depends 003, 011, 012. | Four one-hour clinics per month per pooled group and maximum 16 members are configurable. Seat capacity cannot be oversold; group hours do not consume/create private coaching time. Specialized clinics require funded qualified experts. Recording consent and written-summary option are implemented. |
| CTP-021 | Implement member sharing, export/deletion requests, and audit. Depends 006, 010, 017. | Sharing defaults private, explicitly publishes, and revokes. Own evidence export is authorized; request/deletion job includes storage and platform-derived records subject to documented retention. Staff access/exports, billing adjustments, and privilege changes are logged without secrets. |
| CTP-022 | Implement metric definitions and operational reconciliation. Depends 011, 014, 017, 019, 020. | Dashboard separates paid pilots, conversion, renewal, service revenue, cash, direct service cost, reserved qualified capacity, and reported outcomes. Ledger and job/provider totals reconcile. Demo records cannot enter live metrics; unverified self-reports remain labelled. |
| CTP-023 | Validate state, privacy, and AI reliability controls. Depends 006, 010–017, 021. | Targeted tests exercise cross-workspace access, booking/allowance races, duplicate events, phase boundaries, provider failures, prompt injection, cost stops, and evidence-grounded output. Failed criteria produce actionable defects; rubric tests do not pretend to prove hiring prediction. |
| CTP-024 | Complete full Phase B browser rehearsal and release report. Depends 008–023. | All nine journeys below run against a seeded private build, including AI practice/study and test/manual billing. Desktop/mobile and keyboard checks cover complete flows. Report live/test/manual/disabled state separately; remaining defects and human-coverage gaps are explicit. First slice alone fails this gate. |
| CTP-025 | Prepare controlled production launch and restore evidence. Depends 024 plus business launch gate. | Concrete release artifact, migration/rollback plan, tested backup restore, access/retention settings, provider/tax/terms configuration, billing reconciliation, spend caps, support owner, funded expert roster, and incident procedure are reviewable. Enable live publication/payments/communications only within actual authorization. |

Later commercial work—Specialist/Practice/Partner statements of work, client-system integrations, hosted arbitrary agent execution, recruitment marketplace, organization accounts, multilingual content, and new-country operations—requires separate issue specifications and gates. Do not smuggle these into Phase B.

## Meaningful end-to-end acceptance journeys

1. **Accepted member to reviewed evidence:** an accepted pilot member receives the exact test/manual-paid entitlement, onboards, opens the common foundation, selects an appropriate assignment, submits a valid artifact, receives authorized human review, revises, and exports a portfolio statement labelled as simulated work. Verify each 30-minute review includes preparation and consumes one of the pilot's four units; publishing content alone does not mark member competence.
2. **Privacy attack and revocation:** member B cannot read member A's evidence through guessed routes, object identifiers, or staff APIs. A reviewer sees only assigned material. Revocation prevents obtaining a new download link; prior short-lived links follow the documented expiry. Editor access cannot reveal member submissions.
3. **Last slot and last unit:** two members attempt the same slot; exactly one booking wins. One member opens two bookings with only one unit; exactly one reserves it. Cancellation/no-show/platform failure applies the disclosed policy and restores a replacement credit exactly once. The monthly coach unit reserves 45 call minutes plus 15 preparation minutes.
4. **Pilot, continuation, renewal, and payment interruption:** run standalone CAD 3,000 pilot, explicit CAD 9,000 ten-month conversion, and twelve-month renewal/direct Professional. Ensure original anniversary, exact allowance totals, invoices, and payment schedule are correct. Duplicate/delayed/out-of-order test events, failed instalment/recovery, cancellation, and manual refund decisions remain consistent. Unconverted pilot is never charged again.
5. **AI consent, grounding, quota, and cost:** opt-out prevents dispatch. Deterministic demo is visibly simulated. Live provider absence disables live execution without breaking demo. A timeout is recoverable without duplicate paid work. Monthly 20-mock/100-study allowances and the 30-turn cap are enforced. Sparse interviews return insufficient evidence; study output uses permitted sources; a budget stop triggers a truthful service-recovery path.
6. **Content and template update:** member starts version 1; editor publishes version 2; original review retains its rubric/content references. New enrollment uses eligible current material. A template shows tested compatibility, known failures, and stale/retired status. Nothing in an uploaded document can grant AI permission to send messages or access systems.
7. **Post-program ongoing service:** after explicit continuation, member receives only the next month's Professional allowance, attends an available clinic, uses one goal/renewal workflow, books covered support, and sees appropriate activity. Clinic participation does not create private hours; training completion never auto-increments rate increases or verified contracts.
8. **All-role admission and truthful expertise:** a cybersecurity or product contractor can onboard into the foundation when their branch is limited. They see actual scope, readiness, and reviewer coverage. Tailored service waits for coverage; an appropriate available service proceeds. A project manager is not assessed using a generic coding rubric.
9. **Operator reconciliation and privacy lifecycle:** operator resolves a booking exception, reviews an early-release/refund request, reconciles invoice/ledger/provider/manual records, exports an authorized member's data, and completes a deletion workflow with retained-record exceptions documented. Cost report counts preparation once, distinguishes estimated AI cost, and excludes demo events from live business metrics.

Use unit tests for financial/state rules and authorization policies, integration tests for database transactions and provider event handling, and browser tests for these journeys. Do not test every static label or use a scaffold screenshot as proof of function. Run checks appropriate to changes; broaden when unresolved risks justify it. An automated pass is technical evidence, not customer demand or real-provider verification.

## Largest scope and control risks

1. **Breadth can consume the business before demand is known.** Serve every IT role from day one through a genuine shared foundation and explicit role-branch readiness. Expand tailored material and coaching only with authored work and confirmed expert coverage; do not equate broad enrollment with completed expertise in every domain.
2. **High-priced membership can quietly become unlimited consulting.** Define review size, support purpose, session counts, turnaround targets, availability, cancellation, and escalation before checkout.
3. **Human capacity is the limiting resource.** A sales funnel must not admit more obligations than coaches and domain reviewers can fulfil at acceptable margin.
4. **A generic AI score can undermine trust.** Preserve evidence, rubrics, uncertainty, and human accountability; separate practice feedback from verified proficiency.
5. **Member uploads can contain client information.** Prefer synthetic exercises, scoped sharing, explicit provider choices, and private storage; do not request client-system integrations in the MVP.
6. **Billing, service access, and entitlements can drift.** Version offers; use immutable ledgers and idempotent events; reconcile before taking live payments.
7. **Demo success can be mistaken for production readiness.** Label environments visibly and list configuration, delivery capacity, and real-provider verification still outstanding.
8. **CAD 120k can distort the product.** Keep it a hypothesis for a separately costed bespoke engagement; it must not determine the initial platform architecture or imply individual willingness to pay.
