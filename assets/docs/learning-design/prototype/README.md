# Write, check, improve — local content walkthrough

Open [the walkthrough](index.html) through a local HTTP server. It connects the authored Lesson 2 request exercise to Lesson 3 claim checking, correction and a revision reason. Everyday, Work and Technical routes each use a worked example and a different fresh source.

The five steps are **see an example → write a request → check claims → repair → review**. A supplied teaching sample is clearly labelled; it is not generated from the learner's request. A wrong classification gets a source-specific explanation and a retry. Claim order varies across routes. Free writing uses an observable self-check rather than a character-count grade. Editing the request, correction or reason clears self-checks tied to the earlier text.

Use invented information. **Save in this browser** stores only this route's practice in browser storage for the same origin; it does not save to a member account. Different routes retain separate in-page drafts. Reload restores only explicit saves. Changing host/port or clearing browser data can make a save unavailable. **Download my work** provides a plain-text copy of the source, request, classifications, correction and reason, including when browser storage fails.

## Run and inspect

From the repository root, with Python 3 available:

```sh
python3 -m http.server 0 --bind 127.0.0.1 --directory assets/docs/learning-design
```

Use the printed port and open `http://127.0.0.1:<port>/prototype/`. Keep that server running. It serves only the content-design directory and needs no database, provider or account. Reuse the same host/port to revisit browser saves. The current owner's local preview address is recorded in the issue handoff; do not start another server on an occupied port.

Using the repository's installed Node 24+ and Playwright, run the focused checks with your URL and an evidence folder outside the checkout:

```sh
node assets/docs/learning-design/prototype/checks.mjs <preview-url> <evidence-directory>
```

The check runner uses Chromium at 1280 × 900 and 390 × 844. It does not use the application's shared browser port or database. Its `results.json` and screenshots are local storyboard evidence, not the complete application/browser matrix or a new L-series coverage claim. No new test dependency or runner package was added. To reproduce one scenario, append `--case PROTO-008`, for example.

## BDD and observed evidence

All eight [local scenarios](learning.feature) have explicit browser checks in [checks.mjs](checks.mjs). PROTO-001/002/003 run once per route at both widths (six cases); PROTO-004–007 each run once (four cases); PROTO-008 covers request, correction and reason edits separately (three cases): thirteen total. These demonstrate local portions of the broader [learning specifications](../traceability.md), not member persistence or staff feedback authority.

| Local IDs     | Broader design connection                                 | Executable outcome                                                                           |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PROTO-001–003 | LEARN-FLOW-003/004/005/006/007/008/010/013; WORK-FLOW-004 | Fresh source, request, correction feedback, before/after/reason, explicit local save/reload. |
| PROTO-004     | LEARN-FLOW-011, limited to route draft separation         | Switching examples retains each in-page draft; no account goal/version mutation is tested.   |
| PROTO-005     | LEARN-FLOW-009; WORK-FLOW-007, browser-only subset        | Failed storage leaves editable text and a verified downloadable copy.                        |
| PROTO-006     | LEARN-FLOW-010, browser-only subset                       | Malformed saved state is reported and not overwritten on load.                               |
| PROTO-007     | LEARN-FLOW-008/013                                        | Worked-example origin and self-check are explicit; no automatic proficiency claim.           |
| PROTO-008     | LEARN-FLOW-008; WORK-FLOW-004                             | Revisions clear prior self-check marks.                                                      |

Before implementation, the actual page returned a directory listing rather than the expected lesson heading; the browser check failed. The first complete version passed ten cases. Author inspection then varied the claim order to avoid answer-position learning. A new revision check exposed stale self-check marks after editing: it failed with a checked box where an unchecked box was expected, then passed after the fix. Exact commands, immutable first-run reports and source hashes are recorded in the local issue evidence directory, not rewritten as an uninterrupted pass.

The actual learner-account reader, private submission and reviewer exchange remain outside this prototype. The #117 worker retains the shared reader/source scope. Production work remains parked. All six lessons and final practice are now available in the [complete local reader](../reader/README.md); this walkthrough and its storage remain unchanged. The Everyday, Work and Technical rehearsals are now recorded. The [fifteen-item refinement](../practice-refinement.md) is now complete in that reader. The [three follow-up dialogues](../study-dialogues.md) are now complete locally. The optional [contribution exercise](../contribution-practice.md) is also complete locally, with first/revised proposals, a separate audience plan and explicit notebook save/reload/export. The [realistic Work brief](../realistic-work-practice.md) is now authored and rehearsed locally: changed notes, capacity tradeoff, usable update and retained revision.

The [realistic Technical investigation](../realistic-technical-practice.md) is now authored and rehearsed locally: conflicting requirements, bounded observations, a useful reproduction/test plan and a retained revision after a later update.

The [realistic Everyday planning case](../realistic-everyday-practice.md) is now authored and rehearsed locally: changed arrangements, attendance states, capacity choices, a useful reminder and a retained checklist revision.

The [guided final-practice checkpoint](../reader/guided-final-practice.md) now presents all three cases as brief → first draft → update → revision, preserving existing writing and explicit saves. READER-026–028 added eleven browser cases; that checkpoint passed 107 cases.

The [field-guidance refinement](../reader/guided-final-practice.md#field-guidance-refinement) now places all eighteen existing numbered instructions beside the corresponding final-practice fields and shows the case’s expected output. READER-029 adds six route/width checks; the full reader suite passes 113 cases with the same sources and preserved notebooks.

Next bounded action under [#34](https://github.com/deepnative/deep-native-engine/issues/34): audit the complete local learn → apply → feedback → contribution journey against its original BDD requirements and current authored content. Several local refinements now exist; reconcile the package as a whole and identify a concrete missing learner outcome before adding another slice. Reuse the completed rehearsals and executable evidence, preserve #93/#117 canonical/shared-reader claims, and recheck live ownership. Lead Sol/High; author content/evidence review High. Production remains parked.
