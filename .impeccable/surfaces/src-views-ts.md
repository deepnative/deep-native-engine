---
version: 1
slug: "src-views-ts"
primary_target: "src/views.ts"
related_targets: ["public/style.css", "src/administrator-entry-routes.ts"]
---

## Scope

Mode: Persuade. The welcome landing at `/` remains Persuade. The learner dashboard, starter lesson and activity view use the same palette/font in Operate mode; their task layouts and behavior stay intact. Account, billing, administrator, support and error pages share the same default palette/font in Operate mode; their existing task layouts remain intact. This is a code-led implementation of the user's already chosen Duolingo/Quantic/Khan learning-product synthesis. Routine design decisions are delegated; no new concept approval round is needed.

## Direction contract

THESIS: Let a visitor experience one useful learning decision before signing up. Replace the passive green headline and long survey with an active lesson invitation.

OWN-WORLD: Bright warm paper, deep blue ink, confident blue actions and small butter-yellow learning markers. Self-hosted Nunito Sans pairs friendly, heavy headlines with crisp readable task text. Native answer disclosures and numbered learning steps provide structure, without mascots or invented scores.

STORY: Understand the practical AI offer, compare two instructions, read specific feedback, then choose a starting point. Optional profile information is progressively disclosed; privacy and recovery facts stay available before starting.

FIRST VIEWPORT: A large left-aligned promise and primary start link beside an oversized real exercise on a blue learning surface. Below, a horizontal learn–try–apply path leads into a short two-choice onboarding form. On narrow screens the promise and action precede the exercise; all content reflows in one column.

FORM: The user-pinned familiar learning-product direction overrides the random assignment; seed:ece05d4a1077df38 records exploration, not a new user selection. The signature interaction opens a sample answer to reveal grounded corrective feedback, with no account or saved progress. Code-led; no generated comp or raster imagery is required for this working native exercise.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints

Preserve native labels, CSRF, all profile fields, safe attempted values and field-linked errors. Open optional fields on an error response. Keep account/profile content, layout and behavior unchanged while applying the shared identity. No fake learners, streaks, completion, accreditation, AI calls, pricing promises or support capacity. Preserve old preview resources; show this source in a fresh owned local preview.


## Administrator console — Operate

The verified-owner `/operator` console shares this identity with compact task text and existing flat form/list controls. Learners, Courses/services and Invoices are named destinations; an exact learner reference opens minimal enrollment/billing summaries and existing proposal functions. Keep private writing/files/email out of the console, finite authority explicit, and learning identity separate. Disabled billing remains disabled; published lesson candidates do not promise staffed services. Long references/actions wrap on mobile. ADMINCON01–04 and L277 own behavioral evidence; original missing-route failure, captures and final-source results are recorded on #570. This brief does not establish deployment or commercial acceptance.
