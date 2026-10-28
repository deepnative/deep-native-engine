# Lesson 6: a reasoned feedback decision

Open [the local reader](http://localhost:56274/reader/) → **Lesson 6 → Fresh case**. Choose Everyday, Work or Technical. The decision workspace connects the supplied source, original comment version, current draft, a reasoned response and retained history. It uses the reader's existing notebook and explicit browser save.

This is the local [#549](https://github.com/deepnative/deep-native-engine/issues/549) checkpoint `DNE-2026-10-27-549-learner-feedback-root`, based on `c97347e478e5f4b955b208ffeb273c35bd6f94d5`. Production remains parked.

## Three different useful outcomes

| Route / case       | Source and comment                                                                                                                         | Actual author rehearsal                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Everyday / L6-E-X  | Nine people, forty-five minutes on Wednesday; room undecided. A v1 comment suggests twelve people in Room 4.                               | Declined the unsupported suggestion, retained v1 exactly and kept a precise question asking for an updated source.                       |
| Work / L6-W-X      | Noor owns the agenda; Lee invites participants. V1 misassigned the agenda; supplied v2 already corrects it. The comment still concerns v1. | Recorded already addressed in v2, retaining its text and both supplied versions. No v3 or new-review claim was created.                  |
| Technical / L6-T-X | PDFs up to 2 MB; no test has run. V1 claims a 3 MB rejection test passed.                                                                  | Created v2 separating the expected rejection, not-run execution and absent observation. V1 and its original comment remain identifiable. |

Codex performed all three through the browser on 27 October 2026, then explicitly saved, reloaded and exported each record. The actual reasons point to the corresponding source and version. These were author rehearsals with prior knowledge of the cases, not independent learner research. No PDF form or real test was executed, and no clarification was sent.

## What the learner can do

Read the source and comment together, inspect the current draft and expand its version history. Select **My decision**, write **My reason**, and optionally keep a clarification question. For **Revise**, edit the proposed text and inspect the before/after comparison. **Add decision to my notebook** records the decision in the open page; **Save in this browser** confirms persistence.

A choice and reason are required. A revision needs different nonempty text. Already addressed requires a version newer than the comment. Declining or already addressed preserves the current artifact exactly; it does not create another artifact version. If a proposed revision was written before choosing to retain the text, the unapplied proposal remains in the decision record. Adding a record clears the form for another response without duplicating the last decision.

These are structural checks. Different reasoning is allowed; nonempty writing is not proof of correctness. Supplied source guidance helps the learner compare their choice without assigning an automatic grade. The path says **Decision recorded**, not learned, mastered, approved or reviewed. Editing a response clears any earlier Lesson 6 self-check.

Unfinished responses and recorded decisions survive an explicit save. The downloaded notebook includes sources, original and later versions, comment version, decisions, reasons, clarification and any unfinished response. A storage failure retains the in-page response and download option. An unreadable or inconsistent stored history remains protected and separately downloadable.

## Content and notebook continuity

[feedback-cases.json](feedback-cases.json) structures the three existing fresh cases from [Lesson 6](../lessons/06-feedback-and-revision.md). It supplies concrete draft wording for the same facts, along with practice guidance. `build.py` checks the case IDs, exact sources and comment phrases against that lesson and includes the JSON in the generated content hash. The seven existing authored Markdown sources, 24 question keys and their worked examples are unchanged.

New content hash: `a63aa78cb2a451f4bbaba9b38d1e31efe61741d4aff8469402ea8d9760975178`. This has a separate browser-storage key from the earlier reading notebooks. Earlier answers and self-checks are not silently copied into the new content version; use **Earlier notebooks** to download them. The actual earlier Technical notebook was downloaded again and matched the previous checkpoint byte for byte, including six own-work responses, six fresh responses and six final fields.

Current notebooks hold a route-specific feedback record. Stored history validation checks its case, comment version, artifact version transitions and retained text. Another route's record, a changed comment version or changed text masquerading as a retained artifact is protected from overwrite. This local notebook is not a submitted member artifact or an atomic multi-user service.

## BDD and observed evidence

The original 73 design/local scenario IDs remain intact. Four new scenarios bring the package to 77 and the reader to 16. The application journey register is unchanged.

| Scenario   | Executable checks                                                                                                                                                                                                                            | Exact evidence boundary                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| READER-013 | Three complete route journeys at 1360 and 390 pixels inspect source, practice origin and v1 comment beside the current draft.                                                                                                                | Supplied local context, not a real reviewer exchange.                                                             |
| READER-014 | Those journeys exercise decline/already addressed/revise. A separate validation journey rejects missing decisions/reasons, empty or unchanged revisions and an absent newer version; it then retains v2 after an already-addressed decision. | Structure and history, not semantic grading of prose.                                                             |
| READER-015 | Save/reload/export in all routes; failed write preserves earlier stored bytes and the current downloadable response; three inconsistent histories remain protected; unfinished response survives save.                                       | Browser storage, not database/member persistence. Existing READER-006/012 checks retain earlier-content recovery. |
| READER-016 | Route switching keeps distinct drafts; browsing alone does not warn, changed writing does; edits clear the Lesson 6 self-check; HTML-looking writing stays literal, including an unapplied proposal.                                         | Local writing/isolation and truthful progress only.                                                               |

Six new journey checks failed on the missing workspace before implementation, then passed. The first full run passed 36/42: six existing course journeys hit an ambiguous selector because the new workspace added two disclosures. The selector was scoped to the original lesson comparison; its original open-state assertion remains. The subsequent full reader suite passed **42/42, zero failures, zero retries**: the original 29 cases plus 13 feedback cases. Reports retain the original failures and repair, rather than hiding them as retries.

Rendered review inspected the desktop before/after comparison and the desktop/narrow decision panels. Source generation, scenario IDs, links, unchanged authored sources, syntax, formatting and the scoped diff are checked separately. This is author self-review; no independent review, full application gate, 99% coverage result, hosted deployment or measured learning outcome is claimed.

Evidence directory: `/Users/tomwu/Documents/Codex/2026-10-27/dne-content-workflows-bdd/learner-feedback/`.

- `red/`, `first-journeys/`, `first-full-run/`, `final-run/`: retained reports and screenshots.
- `everyday-feedback-record.txt`, `work-feedback-record.txt`, `technical-feedback-record.txt`, `manual-observations.json`: actual save/reload exports and version outcomes.
- `earlier-technical-notebook.json`, `notebook-preservation.json`: actual earlier notebook and byte-preservation check.
- `baseline.json`, `static-checks.json`, `verification.json`, `self-review.md`: source/diff/commit evidence and review limits.

Reuse the content-only preview at port 56274. If it has stopped and the port is free, run `python3 -m http.server 56274 --bind 127.0.0.1 --directory assets/docs/learning-design` from the repository root. Keep the same host/port for browser saves. See [the reader README](README.md) for regeneration and the focused runner.

## Next bounded action

Under #549, consolidate a content acceptance review against AC1–6: inspect source correctness, misconception feedback, transfer difficulty and useful learner artifacts across all six lessons and three routes, using the recorded reader, authoring and feedback evidence. Identify any concrete content gap before choosing another feature. This is the next step because the planned local workflows now run, while interaction checks alone cannot establish teaching quality. Lead Sol/High; author design/self-review High. Preserve #93/#117/#103/#114 claims; canonical adoption, actual learner research and production remain separate.
