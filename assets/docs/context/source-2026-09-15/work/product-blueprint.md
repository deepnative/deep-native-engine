# Contractor platform: build-ready product blueprint

## Status and product boundary

This is an implementation proposal, not a claim of customer demand, legal approval, integration availability, or completed software. All CAD prices and allowances are hypotheses to validate. The initial paying customer is one independent IT contractor. Every member starts in a private individual workspace; supporting agencies and employer accounts is deferred.

The product promise is: help an experienced contractor choose a valuable development path, practise realistic work, produce credible evidence of capability, and keep improving through expert feedback and useful workflows. Do not promise placement, income, certification, client approval, or an interview pass.

Initial offers:

- CAD 3,000 for the first two billing months, with eight instruction weeks. Start with five members across the eligible IT-role taxonomy and confirm expert coverage for each promised tailored service. Use the pilot to validate demand, delivery effort, skill assessment, and continuing membership purchase.
- On explicit conversion, CAD 9,000 buys the remaining ten months of the first membership year, paid upfront or in ten CAD 900 instalments. Total first-year price is CAD 12,000. Do not collect a fresh CAD 12,000 in addition to the pilot fee or silently auto-convert a pilot.
- CAD 12,000/year founding membership renews for twelve months. A direct annual start can be CAD 12,000 upfront or CAD 1,000/month on a twelve-month term. Instalment billing is not automatically a cancel-anytime offer. Early termination and refund handling remain operator workflows governed by reviewed terms rather than assumed legal conclusions in code.
- CAD 24,000, CAD 48,000, and CAD 120,000/year: provisional bespoke service levels. Display as application/inquiry options only when scope, staffing, and a customer-specific business case exist. Do not make these checkout products in the MVP.

Serve all IT contractors from the initial positioning and enrollment. The role taxonomy includes software development, QA/testing, data/analytics/AI, cloud/DevOps/platform, cybersecurity, architecture, business analysis, project/program/delivery management, and product ownership/product management. Members may choose more than one role. Do not narrow marketing or admissions to developers and QA.

Build a shared foundation for all roles, then role-specific branches. Every branch has an explicit readiness state: published, limited, or coming soon. Readiness covers available material, assessment validity, and human expert coverage, not merely whether a page exists. All roles can use the initial assessment and common foundation; sell tailored coaching or domain-specific assessment only after the promised expert coverage is confirmed. Initial fuller pathways can cover software/QA and business-analysis/delivery while other members receive accurately described foundation services and covered individualized work. Additional roles and domains are content expansion, not new hardcoded applications.

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

Keep entitlements in versioned offer data, never scattered across UI conditionals. The business plan sets final allowances; the following is a conservative product configuration for testing and must be checked against the operating model before launch.

| Allowance | First two billing months / eight instruction weeks | Standard renewed CAD 12,000 annual membership |
|---|---:|---:|
| Structured pathway | Shared foundation plus a covered role branch | Shared foundation and eligible published role branches |
| Individual coaching | Four 45-minute sessions total | One 45-minute session per membership month |
| Project review | Two standard reviews total | Six standard reviews per membership year |
| Human mock interview | One 45-minute session total | Four 45-minute sessions per membership year |
| AI text mock interview | Eight total | Six per membership month, with a session length cap |
| Agent templates | Founding library | Eligible maintained library |
| Group clinic | Scheduled cohort clinics | Published clinics with a defined seat capacity |
| Support | Platform and learning logistics | Platform and learning logistics; expert work uses its specified allowance |

An annual membership year and a membership month are anchored to the original activation date, not the calendar year. A January 31 activation needs an explicit end-of-month policy. The pilot occupies billing months one and two; eight instruction weeks do not silently redefine a billing month. Conversion starts month three and ends at the original year-one anniversary. The conversion offer must separately define remaining allowances: pilot-consumed services remain recorded, and conversion cannot accidentally grant a second full annual bundle. Annual payment does not make monthly coaching allowances available all at once. No rollover in the initial offer unless a signed agreement says otherwise. Platform-caused cancellations restore access or issue the defined credit. Allowance policies are visible before purchase and preserved with each order.

Each standard review is bounded by an announced artifact size, scope, and reviewer effort. Define resubmission allowance separately; do not imply unlimited revisions. Preparation, note-taking, project reading, and reviewer calibration count toward the staffing cost budget; they are not additional customer-facing coaching entitlements. Support response targets refer to working days in a published timezone and exclude emergency assistance. Bespoke tiers use signed, versioned statements of work and cannot bypass staffing checks.

Show both remaining member allowance and available provider capacity. Entitlements are not evidence that an appointment exists. Before accepting a member, reserve forecast capacity for contracted support plus scheduling slack. Sales capacity is limited by the scarcest service, such as domain reviewer availability, not just the number of coach accounts.

## Screen map and thin first release

The list below is the target screen map, not twenty separate screens to implement before a pilot. The thin pilot combines it into seven working areas: public offer/application, member home/onboarding, pathway/assignment/review, template library, booking/usage, member settings, and staff worklist/content operations. A manually recorded paid agreement can support a founder-operated pilot before payment automation. Dedicated analytics, interview, billing, privacy-processing, and continuing-support screens arrive with their corresponding enabled functions.

Build one complete vertical slice first: accepted member → common foundation → private submission → assigned human reviewer → published feedback. Demonstrate its authorization and evidence controls before adding automated subscriptions, interview agents, or complex dashboards. Do not create empty navigation or database modules as a substitute for this journey.

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
| Capacity | `staff_service_types`, `availability_rules`, `availability_exceptions`, `slots`, `bookings`, `booking_events`; UTC timestamps, display timezone, hold expiry, concurrency guard |
| Learning | `pathways`, `pathway_versions`, `content_items`, `content_versions`, `source_references`, `enrollments`, `lesson_progress`, `learning_plans` |
| Assessment | `assignments`, `assignment_versions`, `rubrics`, `rubric_versions`, `submissions`, `submission_versions`, `evidence_objects`, `review_assignments`, `reviews`, `review_criteria`, `appeals` |
| Interviews | `interview_scenarios`, `scenario_versions`, `practice_sessions`, `practice_turns`, `feedback_runs`; evidence references, result status, evaluator/model version |
| Templates | `templates`, `template_versions`, `template_test_runs`, `compatibility_records`, `template_feedback`; source/license, maintained status, known limitations |
| Advice | `goals`, `member_assignment_dates`, `session_notes`, `action_items`; note visibility and member approval where needed |
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

Timing is a planning assumption for one capable builder using AI assistance plus available domain expertise. Scope and evidence, rather than elapsed weeks, determine readiness.

### Phase 0 — Offer and delivery validation, weeks 1–2

Recruit a small pilot cohort from the full IT-role audience, establish the content rights and expert roster, prepare shared foundation work with role-appropriate exercises, document offer terms, and map manual delivery. Prototype the main journey with synthetic data. Secure paid pilot commitments before extensive implementation. Gate: at least a defined minimum cohort, signed scope, reviewer availability for each sold service, truthful branch readiness, and a costed delivery plan; otherwise revise the offer.

### Phase 1 — Founding pilot product, weeks 3–8

Ship access control, application/onboarding for every IT role, the common foundation, role-branch readiness, private evidence submissions, covered human review, simple booking/allowances, a template download registry, and staff worklist. Prioritize first complete paths in software/QA and business-analysis/delivery according to enrolled needs and authored material; readiness remains limited until each path is actually complete. An operator can record pilot agreements and scheduling exceptions. Automated billing and AI text interview are subsequent slices; absent integrations stay disabled. Gate: complete founder-led dry run of the enabled member/coach journeys; no cross-member access; no tailored sale without expert coverage; staffing capacity reconciles to sold allowances.

### Phase 2 — Annual membership, weeks 9–16

Improve continuing support, expand role branches based on real member needs and available experts, harden subscription lifecycle and privacy operations, calibrate AI practice feedback, and enable configured live billing after launch approval. Gate: pilot delivery costs support the offer, genuine program completion is documented, and some members explicitly purchase the CAD 9,000 continuation. Do not infer conversion or renewal from positive survey responses.

### Phase 3 — Repeatable delivery, months 5–8

Add reviewer calibration, service quality metrics, progressively complete more role/domain pathways when demand and expert capacity support them, calendar/email integrations, voice practice if worthwhile, and improved member-controlled portfolios. Consider CAD 24k bespoke advisory only with proven recurring need and costed capacity.

### Phase 4 — Premium and expansion, months 9–12+

Consider CAD 48k and CAD 120k bespoke advisory only after customer-specific needs, margins, outcome boundaries, and expert teams are established. Potentially add consulting-business development support, permitted sandboxed agent execution, and organization-sponsored seats as separate gated projects. International reach adds timezone, payment, tax, privacy, and coaching-coverage requirements; CAD billing does not imply every jurisdiction is ready.

## Implementation-ready issue backlog

Create these as local issue specifications first. Create issues in a remote repository only when the user authorizes that repository action or the project instructions already authorize it. Every issue should name its phase, dependency, acceptance evidence, and excluded scope.

| ID | Issue and dependencies | Acceptance evidence |
|---|---|---|
| CTP-001 | Inspect target repository and record implementation decisions. None. | Existing instructions and assets inventoried; reuse decision documented; chosen runtime, auth, database, deployment, and adapter approach recorded; no other repository changed. |
| CTP-002 | Version founding offer, phased prices, terms, and capacity assumptions. Depends 001. | CAD3k first-two-month pilot, explicit CAD9k ten-month conversion, and CAD12k renewal/direct annual terms stored as data; original anniversary preserved; no double annual allowance grant; bespoke tiers application-only; sold obligations checked against role-qualified capacity including preparation effort. |
| CTP-003 | Create synthetic demo and environment configuration checks. Depends 001. | Clearly labelled seeded demo works without credentials; missing live provider shows actionable configuration state; demo cannot reach production providers. |
| CTP-004 | Implement identity, individual workspaces, and staff assignment authorization. Depends 001. | Two-member, coach, reviewer, and admin fixtures show correct read/write boundaries; revoked assignment loses access; direct API calls cannot bypass UI restrictions. |
| CTP-005 | Implement all-role application, readiness, coverage, and onboarding. Depends 002, 004. | Every IT role can onboard into common foundation; chosen roles, goals, and consent survive reload; branch readiness is truthful; no paid tailored commitment without matching expert coverage; applicant sees covered scope before accepting it. |
| CTP-006 | Implement versioned content, rubrics, and source registry. Depends 004. | Editor drafts and publishes; member sees only eligible published content; pinned assignment retains original rubric after later publication; provenance and permissions visible. |
| CTP-007 | Implement learning plan and progress. Depends 005, 006. | Member completes one real pathway slice; progress records actual completion actions; staff can assign a plan only to authorized members. |
| CTP-008 | Implement private evidence upload and lifecycle. Depends 004, 006. | Unauthorized/member-crossing downloads fail; invalid/oversized files rejected; quarantine blocks review; replacement creates a new version; deletion removes eligible objects and derived links. |
| CTP-009 | Implement assessed submissions and human reviews. Depends 007, 008. | Reviewer receives an assigned version, publishes criterion-level feedback with evidence references; member revises; old feedback remains attached to old work; simulation badge survives portfolio export. |
| CTP-010 | Implement immutable entitlement ledger. Depends 002, 004. | Grants, holds, consumption, expiry, release, and adjustments reconcile; concurrent requests cannot spend one unit twice; repeating event keys changes balance once. |
| CTP-011 | Implement coaching capacity and booking. Depends 004, 010. | Real availability and timezones shown; parallel booking attempts produce one winner; cancellation restores units per policy; platform cancellation preserves both histories and member credit. |
| CTP-012 | Implement versioned template registry and downloads. Depends 006. | Every published bundle includes sample inputs, expected output, setup, verification, known limits, and test record; deprecated version warns clearly; download does not run client-system actions. |
| CTP-013 | Implement orders and payment adapter in test mode. Depends 002, 004, 010. | Payment redirect alone cannot activate access; signed events verified/deduplicated; invoice terms preserved; initial successful payment grants exactly once. |
| CTP-014 | Implement phased subscription lifecycle and member billing view. Depends 013. | Pilot completion does not auto-convert without explicit agreement; CAD9k continuation preserves original anniversary; renewal/direct-annual instalment term shown accurately; renewal failure/recovery, scheduled cancellation, operator-handled early release/refund, dispute, and upgrade states follow specified policy; access end date visible. |
| CTP-015 | Implement AI job gateway, consent, usage budgets, and kill switch. Depends 004, 010. | Opted-out evidence never sent; missing provider produces honest disabled state; retries deduplicate; input injection cannot invoke tools; estimated/actual spend distinction visible; quota and global stop enforced. |
| CTP-016 | Implement text mock interview with grounded feedback. Depends 006, 015. | Scenario produces follow-ups from answers; feedback cites actual turns; sparse answers yield insufficient evidence; fabricated experience is not accepted as reviewed proof; session cap limits cost. |
| CTP-017 | Build assigned-member worklist and service operations dashboard. Depends 009, 011, 014. | Staff see only assigned/private scope; queue exposes review age and real booking capacity; failed jobs and payment exceptions actionable without raw secrets or evidence logs. |
| CTP-018 | Add member-controlled sharing, export, deletion request, and audit. Depends 008, 009, 014, 015. | Private by default; explicit publication and revoke work; export restricted to owner; deletion job covers storage and platform-derived records with documented retention exceptions; staff access logged. |
| CTP-019 | Add one continuing-support journey and renewal preparation. Depends 007, 011. | Active member records a goal, uses included support, receives action items, and prepares a member-controlled renewal summary; no external message sent automatically. |
| CTP-020 | Complete stage-specific end-to-end rehearsal and operational readiness. Pilot depends 005–012 and the minimum assigned worklist/privacy controls from 017–018; annual release adds 013–019 only as enabled. | Representative journeys for enabled functions pass in a real browser using synthetic fixtures; ledger/capacity reconciliation agrees; visual/accessibility checks cover mobile and desktop; disabled billing/AI features cannot be sold or represented as working; open defects reported honestly. |
| CTP-021 | Prepare production configuration and controlled launch checklist. Depends 020 and business stage gate. | Concrete release artifact, migration/rollback rehearsal, backup recovery evidence, configured tax/terms/privacy and provider settings, support owner, spend limits, and approved capacity documented. Production actions require authorization if not already granted. |

## Meaningful acceptance journeys

1. **Purchase to reviewed evidence:** accepted pilot member completes test checkout, onboards, opens the assigned pathway, submits a valid project, receives authorized human review, revises, and exports a portfolio statement labelled as simulated work. Verify the payment event granted once and each review consumed the specified allowance.
2. **Privacy attack and revocation:** member B cannot read member A's submission through guessed routes, object identifiers, or staff APIs. A reviewer sees only assigned evidence. Revoking the assignment prevents obtaining any new download link. Verify prior link behavior matches the documented short expiry.
3. **Last available coaching slot:** two members attempt the same slot; exactly one booking wins. Then a member with one unit opens two parallel bookings; only one can reserve it. Cancellation applies the disclosed deadline and restores the correct balance exactly once.
4. **Payment interruption:** deliver duplicate, delayed, and out-of-order test events; fail a renewal; recover it; schedule cancellation. The member sees truthful payment and access states, invoices stay immutable, and the ledger remains reconciled.
5. **AI refusal, failure, and cost cap:** evidence-sharing opt-out prevents provider dispatch. Provider timeout yields a recoverable job without duplicated charges or allowance use. Global cap blocks another request with a useful explanation. A sparse interview produces insufficient-evidence feedback rather than an invented score.
6. **Rubric/content update:** a member starts against version 1; an editor publishes version 2; the original submission and review retain version 1. New enrollment can use version 2. Published template displays its tested compatibility and a withdrawn version warning.
7. **Post-program continuity and pricing:** a member finishes eight instruction weeks within the two-month billing phase, explicitly buys the CAD9k ten-month continuation, preserves the original anniversary, sees only the defined remaining allowances, and uses monthly support. Total contracted year-one fee is CAD12k. An unconverted pilot is never automatically charged. Completion of a course does not artificially increment interview, earnings, or client-success metrics.
8. **All-role admission and truthful coverage:** a cybersecurity or product-management contractor onboards into the common foundation even when that role branch is limited. They see accurate readiness and receive no fabricated tailored pathway or expert promise. A tailored coaching purchase is held for coverage confirmation; an eligible covered service can proceed without blocking common-foundation access.

Use unit tests for the financial/state rules and authorization policies, integration tests for database transactions and provider event handling, and browser tests for these journeys. Do not write a test for every static label or snapshot a large scaffold as proof of function. Run relevant checks after each material change and broaden only when unresolved risk justifies it.

## Largest scope and control risks

1. **Breadth can consume the business before demand is known.** Serve every IT role from day one through a genuine shared foundation and explicit role-branch readiness. Expand tailored material and coaching only with authored work and confirmed expert coverage; do not equate broad enrollment with completed expertise in every domain.
2. **High-priced membership can quietly become unlimited consulting.** Define review size, support purpose, session counts, turnaround targets, availability, cancellation, and escalation before checkout.
3. **Human capacity is the limiting resource.** A sales funnel must not admit more obligations than coaches and domain reviewers can fulfil at acceptable margin.
4. **A generic AI score can undermine trust.** Preserve evidence, rubrics, uncertainty, and human accountability; separate practice feedback from verified proficiency.
5. **Member uploads can contain client information.** Prefer synthetic exercises, scoped sharing, explicit provider choices, and private storage; do not request client-system integrations in the MVP.
6. **Billing, service access, and entitlements can drift.** Version offers; use immutable ledgers and idempotent events; reconcile before taking live payments.
7. **Demo success can be mistaken for production readiness.** Label environments visibly and list configuration, delivery capacity, and real-provider verification still outstanding.
8. **CAD 120k can distort the product.** Keep it a hypothesis for a separately costed bespoke engagement; it must not determine the initial platform architecture or imply individual willingness to pay.
