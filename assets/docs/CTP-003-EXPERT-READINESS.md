# CTP-003: expert evidence and track readiness slice

Prepared 2026-09-23 for [CTP-003 #20](https://github.com/deepnative/deep-native-engine/issues/20), claim `ctp003-experts-netcsc-20260923`. This is private/local preview infrastructure. No qualified expert, live capacity, tailored booking, or formal review has been approved.

## What the slice records

Migration `007-expert-readiness.sql` creates an expert evidence roster with a staff role, domain, service type, dated window, loaded cost in integer CAD cents, capacity/committed minutes, backup staff ID, qualification/agreement/conflict references, verifier and retirement. Database checks reject role/service mismatch, invalid date/cost/capacity and a verification marker without the required evidence fields. A trigger requires the verifier to have the platform admin role and prevents self-verification. The local app has no self-service route to mark a person verified. Only current operators and platform admins can read the roster; public track pages show aggregate readiness without expert identifiers or evidence references.

The three foundation goals display **in preparation** until all six PLAN-004 lessons are both published and marked as requiring qualified sign-off. The current content workflow correctly blocks such publication while sign-off is pending. Each specialist domain/service pair needs published qualified content and current verified expert evidence for that exact service; otherwise it displays **in preparation**. Synthetic state-transition tests distinguish available, limited coverage, in preparation and retired. A pending roster row never makes a service available. The public page offers no booking, checkout or admission decision; general learners can continue the separate local preview exercise.

## Privacy, verification and limitations

The roster holds references to qualification and agreement evidence, not proof that the documents exist or are valid. A real operator process must verify provider identity, specialty, actual backup availability, current agreement, conflicts, rates and allocated minutes before setting verification. Backup qualification and overlapping commitments across services are not yet automatically checked. The currently empty qualified roster and unpublished foundation drafts keep every runtime track in preparation. A computed state is informational and cannot grant a paid entitlement or commit an expert. Do not populate real personal/provider information into this local preview.

The `initial-learning-v8` browser register adds L27 for a general learner, denied reviewer and authorized operator. PostgreSQL integration verifies pending evidence stays private and cannot be marked verified with missing fields. The full-MVP register remains 100 proposed cases with zero full-release cases covered. These tests are synthetic; they do not establish real expert readiness.

## Remaining CTP-003 acceptance

The owner must name a qualified capacity reviewer, obtain real dated evidence and backup commitments, accept service terms, and approve a workflow that reserves minutes atomically before any tailored service is represented as available. The PLAN-004 content still needs qualified curriculum/domain sign-off and accessibility review. Until those dependencies are met, CTP-003 #20 remains open. This migration is additive; rolling back requires dropping `expert_registry` after exporting any authorized roster records, and the application can disable its read-only routes without changing learner profiles.
