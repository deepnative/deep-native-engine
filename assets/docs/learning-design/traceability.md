# Evidence and acceptance map

Scope: [#549](https://github.com/deepnative/deep-native-engine/issues/549), local content authoring and behavior specifications. Date: 27 October 2026. Baseline inspected: `60c66677d939df8b1d0b59c43a1e8627f45223bc`. No application file or existing scenario denominator is changed by this package.

## How to read the status

- **Authored:** concrete text/examples now exist in this package. This establishes an inspectable artifact, not an application behavior.
- **Observed subset:** the narrower #548 local guide journey was actually demonstrated at the baseline revision using invented data; it is not proof of the new three-lesson sequence.
- **Existing analogue:** implementation and named test source were inspected, but those tests were not rerun for this document task. The new scenario is not automatically covered.
- **Proposed:** an expected behavior or test still needs implementation/verification. No scenario below is newly claimed as an automated pass.

Only the #548 everyday walkthrough has manual observation in this evidence set. Its previously recorded focused checks cover the three starter goals; they do not execute the new content. Existing sample-feedback tests exercise private evidence samples, not a new lesson-specific revision screen.

## Existing evidence anchors

| Anchor | Inspected source / recorded observation | Limit |
| --- | --- | --- |
| E1 | [Starter guide](../../../src/starter-guidance.ts); [GUIDE-01/02/03/04/06/07 browser journey](../../../tests/e2e/starter-guidance.spec.ts), L242–244; [GUIDE unit behavior](../../../tests/unit/starter-guidance-http.test.ts). | Original starter questions, not LD-FND lessons. Manual everyday walkthrough: example, wrong 15-volunteer choice, correction/hint, distinct book-swap case, private save/reload, no auto-completion. Recorded 27 Oct at 20:36:29 UTC on dedicated local preview. |
| E2 | [GUIDE-04/05/06 native integration](../../../tests/integration/starter-guidance.test.ts); [starter plan](../../../tests/integration/starter-plan.test.ts); [L89 exact history](../../../tests/e2e/starter-history.spec.ts). | Existing private writing, goal/version isolation and historical behavior; no persisted question-step position. |
| E3 | [Catalog L25/L26/L73/L75](../../../tests/e2e/catalog.spec.ts); [content lifecycle](../CTP-007-CONTENT-LIFECYCLE.md). | Existing synthetic catalog lifecycle, role boundaries and pinned versions. Historical qualified-signoff wording for ordinary foundations is superseded by current owner direction and live #93 scope; other worker changes are not verified by this checkout. |
| E4 | [L62 activity/progress](../../../tests/e2e/progress.spec.ts). | Existing opened/started/self-reported states, not a new mastery model. |
| E5 | [L139–141 sample feedback](../../../tests/e2e/sample-feedback.spec.ts). | Source-bound private evidence feedback, one clarification, new private revision and withdrawal. Not a criterion editor, lesson artifact comparison or formal assessment. |
| E6 | [L71 workflow feedback](../../../tests/e2e/workflow-feedback.spec.ts); [native version/privacy/conflict behavior](../../../tests/integration/workflow-feedback.test.ts); [L151–153 unconfirmed-save recovery](../../../tests/e2e/workflow-feedback-recovery.spec.ts). | Private workflow-feedback notes and recovery. Does not establish identical failure handling for a new learner artifact editor. |

## Content creation / refinement scenarios

| Scenario | AC | Artifact / behavior | Current evidence | Planned verification if implemented |
| --- | --- | --- | --- | --- |
| CREF-001 | 1, 3 | Curriculum outcome, prerequisite and artifact across routes. | Authored: curriculum and all three lesson openings. | Author walks each route; checks artifact against outcome. |
| CREF-002 | 2, 3 | Budget answer-key correction. | Authored: Lesson 3 key distinguishes absent from incompatible facts. | Unit content-key fixture; local editor walkthrough of requested correction. |
| CREF-003 | 2, 3 | Feedback explains the selected misconception. | Authored: six route repair questions; E1 observed subset. | Unit per-choice explanations; browser wrong-choice → specific explanation → retry. |
| CREF-004 | 2, 3 | Fresh transfer source and flexible rubric. | Authored: nine fresh cases across three lessons/routes. | Content inspection; browser source remains the transfer source after feedback. |
| CREF-005 | 3 | Routine local editorial readiness. | Proposed workflow; E3 staff lifecycle is an analogue, not this working state. | Local procedural walkthrough; application role checks only if catalog UI changes. |
| CREF-006 | 3 | Specific change request and before/after wording. | Proposed workflow; simultaneous staffing wording authored in Lesson 2. | Local revision comparison tied to question/version. |
| CREF-007 | 3 | Replace uncertain-rights source and continue independent authoring. | Authored source/rights policy in workflows; no actual third-party rights dispute tested. | Procedural example with excluded passage and original replacement. |
| CREF-008 | 2, 3 | Inspect all teaching stages in all routes. | Authored reading material; interactive preview of these new lessons proposed. | Walkthrough of each new route and wrong/correct/hint/transfer paths. |
| CREF-009 | 3, 4 | Preserve lesson/rubric version of prior work. | Existing analogue E3; new lesson adoption integration proposed. | Real PostgreSQL version pinning plus member history browser check. |
| CREF-010 | 3, 4 | Retirement and retained private history. | Existing analogue E3/E4; replacement recommendation proposed. | Retire item, inspect search and owner history; check applicable deletion path. |
| CREF-011 | 3 | Conflicting author saves preserve both edits for reconciliation. | Proposed; E6 concerns different private-note objects. | Concurrent native integration writes and browser conflict/recovery. |

## Learner journey scenarios

| Scenario | AC | Artifact / behavior | Current evidence | Planned verification if implemented |
| --- | --- | --- | --- | --- |
| LEARN-FLOW-001 | 1, 4 | Relevant example without admission barrier. | Authored three routes; E1 observed subset. | Browser open each new route with general/non-IT/technical backgrounds. |
| LEARN-FLOW-002 | 1, 4 | One recommended next lesson using prior artifact. | Proposed course path; existing starter guide is narrower. | Browser saved Lesson 1 → return → Lesson 2 with correct source. |
| LEARN-FLOW-003 | 2, 4 | Complete example before own writing. | Authored Lesson 2; E1 observed analogous first guide. | Browser worked request → repair question in the selected route. |
| LEARN-FLOW-004 | 2, 4 | Date misconception, retry and draft preservation. | Authored L2-W-P; E1/E2 narrower choice/retry behavior. | Per-choice unit and browser checks; native no draft mutation. |
| LEARN-FLOW-005 | 2, 4 | Hint without correctness/completion claim. | Authored Lesson 3 hint; E1 observed narrower hint. | Browser hint before answer; progress unchanged in database. |
| LEARN-FLOW-006 | 2, 4 | Fresh seed-swap request and relevant feedback. | Authored L2-E-X; E1 observed different original transfer. | Browser transfer uses six helpers/forty packets, never original source key. |
| LEARN-FLOW-007 | 2, 4 | Classify and repair contradiction versus missing fact. | Authored Lesson 3; application classifier proposed. | Unit classification keys; browser two mistakes, corrections and repair. |
| LEARN-FLOW-008 | 2, 4 | Criterion-based own-work self-check. | Authored rubric; richer criterion UI proposed. | Browser short valid artifact versus long incorrect artifact; no auto-grade. |
| LEARN-FLOW-009 | 4 | Failed own-work save retains text and reports truthfully. | Proposed for this editor; E6 is a recovery analogue. | Native persistence failure/ambiguous result; browser retain/reconcile/retry. |
| LEARN-FLOW-010 | 4 | Saved writing resumes, question-state limit is explicit. | E1 save/reload observed; E2 persistence source; question-resume UI proposed. | Browser leave/return and unsaved-step state; native per-member ownership. |
| LEARN-FLOW-011 | 4 | Goal switch leaves old writing and rejects stale practice. | E2 existing guide behavior, no new course integration tested. | Reuse native stale-goal proof; browser switch with retained old form. |
| LEARN-FLOW-012 | 4 | Retained form cannot use the wrong answer-key version. | E1/E2 existing starter version check; new lessons proposed. | Native stale-version submission; browser recovery to correct version. |
| LEARN-FLOW-013 | 4 | Self-check is distinct from formal mastery. | Authored rubric; E1 no auto-complete observed; E4 existing self-report source. | Browser reveal/try/save/finish distinctions; no unsupported grade wording. |
| LEARN-FLOW-014 | 4 | Another member cannot read private work. | E2/E4 existing private work analogue. | Real PostgreSQL outsider/expired/deleted access plus content-free browser denial. |

## Feedback and revision scenarios

| Scenario | AC | Artifact / behavior | Current evidence | Planned verification if implemented |
| --- | --- | --- | --- | --- |
| WORK-FLOW-001 | 4 | Deliberate request on an exact saved version. | E5 existing sample/version analogue; new lesson artifact linkage proposed. | Native source/version and grant checks; browser private save versus request. |
| WORK-FLOW-002 | 2, 4 | Concrete source-based feedback with truthful origin. | Authored count/venue feedback; E1/E5 narrower implemented patterns. | Browser feedback source, version, origin and suggested repair visible. |
| WORK-FLOW-003 | 4 | Clarification/disagreement with source evidence. | E5 existing clarification; explicit disagreement/rationale UI proposed. | Browser clarification and reason; native unchanged original submission. |
| WORK-FLOW-004 | 4 | New artifact version, revision reason and comparison. | Authored worked v1/v2 in workflows; E5 new sample revision analogue. | Native immutable old version; browser before/after/reason view. |
| WORK-FLOW-005 | 4 | Old feedback can be marked already addressed without re-review claim. | Proposed comparison/disposition UI; E5/E6 retain exact source versions. | Browser old-comment/current-version distinction and reason. |
| WORK-FLOW-006 | 4 | Withdrawal stops reviewer exchange, owner retains permitted feedback. | E5 existing sample behavior; new lesson linkage unverified. | Native grant withdrawal checks and browser owner/reviewer comparison. |
| WORK-FLOW-007 | 4 | Failed revision save preserves prior work and recoverable draft. | Proposed for artifact revisions; E6 unconfirmed-note-save analogue. | Native failed/ambiguous save; browser retain correction/reason without false success. |

## Acceptance and author check

| Issue acceptance | Concrete artifact / check |
| --- | --- |
| AC1: outcomes, sequence and routes | [Curriculum](curriculum.md); openings, carried artifact and next action in each lesson. |
| AC2: three authored core lessons | Three lesson files: 6 multiple-choice repair questions, 9 classification claims, 9 fresh route cases, worked examples and own-work rubrics. All facts and keys reviewed against their supplied source. |
| AC3: creator workflow | [Workflows](workflows.md), CREF-001–011. Routine editorial decisions use delegated judgment. |
| AC4: learner and feedback behavior | LEARN-FLOW-001–014 and WORK-FLOW-001–007, including denial, stale state and recovery. |
| AC5: honest evidence mapping | Every one of the 32 design scenarios is mapped above. Existing L-series IDs and test counts are unchanged. No new scenario is reported as executed. |
| AC6: local inspection and next action | [Reading entry](README.md), linked lessons/features and next local prototype in workflows. Local file/link/ID checks and author review are recorded with the handoff. |

Author review checks answer correctness, not just presence of sections. Everyday numerical limits and unknowns match their sources; work examples keep task-specific owners/dates; technical examples separate requirements from execution. Fresh cases have different supplied facts. Three lesson drafts are complete; three later lessons remain briefs. No independent learner study or independent review was performed.

The next bounded action remains under #549: evaluate one local Lesson 2 → Lesson 3 storyboard against LEARN-FLOW-006/007/008 and WORK-FLOW-004, then reconcile any shared reader work with the current #117 claim. Lead recommendation: Sol / High; author design/self-review High. Later private-data or authority changes require the applicable scope and Astra / High routing. Production work remains parked by the owner's direction.
