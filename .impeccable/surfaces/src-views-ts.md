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

## Both-screen path choices

Welcome goal selection uses native radio icon tiles: home for Everyday, briefcase for Work and code for Technical, with visible names/descriptions and Selected path text independent of color. Keep existingeveryday/work/build submitted values, optional field recovery and CSRF. Profile editing retains its select. Use the current Nunito/blue/warm-paper world with green/blue/amber only as path accents, named native controls and visible keyboard focus; no mascot, score, streak or new runtime JavaScript. PATHICON01–03 map to existing rendering, native keyboard and account-reader journeys. The obsolete header environment label is already absent on current main, and task-specific privacy disclosures remain.

## Shared account navigation — Operate (#594)

Owner priority: persistent text links for Learning, Account, Coaching hours, Administration and Sign out across the shared header. Use a wrapping horizontal nav, visible on narrow screens without a hamburger or JavaScript; retain the warm paper/blue/ink/Nunito Sans world. Sign out opens a dedicated confirmation with a clear recovery warning for browser-only accounts; never mutate from GET. Keep saved work and finite authorization fences. Coaching/admin pages explain actual prerequisites without enabling billing or granting access. NAV-01..04/L281 own acceptance; no hosted completion until exact-source release.

Since #846 (owner decisions of 14 November 2026) the header reads Learning, Coaching, Account, Admin (admin view only) and Sign out for every role, on one row at phone width; the view switch is one closed native disclosure ("View: Admin") holding the unchanged switch buttons, placed beside the brand on phones. A signed-out visitor is not offered Learning or the My courses footer link. My account runs: who you are and how you sign in, the learning profile form (the only one; Learning links to it), Billing details, the sharing link, then Your data (download and delete, with the full retention list one disclosure away). Destinations the header already carries are not repeated as buttons.

The member billing details form, on My account since #846, uses the same Operate reading/form layout and shared blue/Nunito/warm-paper identity. Keep name/email distinct from authentication and money authorization, with clear current/validation/stale/uncertain states and ordinary account/proposal navigation. Native labelled inputs and visible confirmation remain; no card/payment widgets or decorative status claims. BILLPROFILE01–05/L280 cover the profile, same-account proposal return and immutable invoice snapshot.


The same account actions also remain visible in the notebook reader, saved-records frame and guided starter lesson, using each existing wrapping header and preserving its links. The global footer carries the product line and navigation; deployment/provider disclaimers are removed while task-specific privacy and recovery information stays beside the relevant action.
