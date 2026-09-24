# QA-005 local keyboard evidence

24 September 2026. Scope: [#129](https://github.com/deepnative/deep-native-engine/issues/129), a synthetic learner-preview slice of [#109](https://github.com/deepnative/deep-native-engine/issues/109). The versioned L53 browser journey uses a real local PostgreSQL-backed server and desktop/mobile Chromium. It starts separate general, non-IT professional and IT sessions, tabs to named controls, verifies a visible 3 px focus outline, submits a short exercise answer, follows the error link, corrects it, and checks exercise and circle state after reload. It then leaves each circle by keyboard. Semantic labels and the saved outcome are assertions, not a screenshot-only check.

I visually inspected keyboard-driven captures from a fresh synthetic local browser session at `127.0.0.1:3000`:

- Mobile skip-link focus: the first Tab reveals the skip link and its amber outline. Enter targets `#main` in L53.
- Desktop exercise-error focus: the error summary names the short verification answer and its link has a visible amber outline. Enter focuses the labelled verification field in L53.

No focus or label defect was observed in these two local captures or in L53's three-path run. The captures were inspected locally and are not committed artifacts; the reproducible L53 browser test and CI report are the durable evidence. Visual focus does not establish VoiceOver behavior, a human assistive-technology sign-off, Firefox/WebKit release support, coach/operator accessibility, connected #42 journeys, or performance/release acceptance; those remain on #109.

The first changed-tree `make verify` ran 106/106 browser executions and 37/37 integration tests successfully, but the repository gate rejected the new `v21` register because its outer scope assertion still expected `v20`. That gate and its repository regression fixture were updated; only a subsequent complete clean-commit verification and CI can establish delivery.

A later dirty-tree `make verify` reached unit tests and observed one first-attempt failure: the readiness route test received HTTP 404 instead of 200 (298/299 passed). The focused readiness suite passed when investigated. That test used Supertest's implicit server, unlike neighboring tests with an explicitly managed server lifecycle. It now uses the same managed agent as those tests. This observed failure remains part of the evidence; a later passing run does not erase it.

The next dirty-tree run passed all 299 unit tests, but L53's first desktop keyboard pass exposed a test assumption: `Home` plus `ArrowDown` did not select a native option on desktop Chromium. The test now uses native select typeahead keys (`e`, `w`, `ww` and `u`, `m`, `i`); a separate desktop/mobile browser diagnostic confirmed all three background and goal values. This is a test correction, not an application accessibility fix. The failed browser run remains recorded (105/106 executions passed) and cannot count as acceptance.
