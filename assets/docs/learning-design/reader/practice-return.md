# Practise a weak part and return to the same record

The local reader now completes the recovery path identified in the [whole-package audit](../package-audit.md): **criterion → specific repair → related practice → retained final draft**. This is a local content/workflow refinement under [#34](https://github.com/deepnative/deep-native-engine/issues/34), completed 28 October 2026. Production remains parked.

## Try it

Open the [local reader](http://localhost:56274/reader/), choose a route and open **Put it all together → Revise and check**. Each of the six criteria retains its original evidence wording. Open **Help me improve this part**, read its repair prompt and choose the named lesson practice. A reminder in the lesson keeps the selected criterion visible. **Return to my final record** restores the revision view and focuses the same criterion.

The first draft and revision stay intact. Navigating or answering practice questions does not change the final self-check; editing the final writing still clears it. A learner can keep an already-correct answer with its existing reason instead of inventing a mistake. Nothing automatically saves, shares or grades their writing.

| Route     | Criterion → lesson to practise                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Everyday  | Usable reminder → 2; Correct headcount → 3; Feasible book plan → 5; Useful revision → 6; Next action → 5; Deliberate audience → 4.                                 |
| Work      | Current facts and changed requirements → 3; A usable output → 2; Sound feasibility reasoning → 5; Useful judgment → 1; A retained revision → 6; Honest limits → 3. |
| Technical | Applicable requirement → 3; Reproducible finding → 2; Bounded conclusion → 3; Useful next action → 5; Retained revision → 6; Honest execution record → 5.          |

The mappings follow the lessons' outcomes: choose a checkable task, write a useful request, check claims, choose use/audience, build a workflow/recovery step, and explain a feedback/revision decision. The practice remains in the selected Everyday, Work or Technical route.

## Source and notebook compatibility

[review-guidance.json](review-guidance.json) supplies eighteen editorial repair prompts and lesson targets. The generator matches each to the exact criterion in its authored case and copies the original evidence and closing guidance. It rejects missing/reordered criteria, missing routes, invalid lessons and empty prompts.

All twelve exercise-source hashes, the content hash, existing generated lesson/capstone fields, keys and criterion evidence remain byte-for-byte equivalent to baseline `86fa39393a2c809c2649f1d73a35acac1af2d018`. The new `reviewGuidance` object has a separate source path/SHA-256. These are supplementary practice instructions; no source or assessment rule changed. This compatibility decision does not allow a future factual, key or criterion change to reuse the old content identity.

An optional route-local `reviewCriterion` records which final criterion the learner is revisiting. Compatible older saves default to no context in memory and are not rewritten on load. Explicit saving during practice retains the position/context across reload. Returning clears the context, without saving automatically. Invalid context values protect the stored original and allow its download. Earlier-version notebooks stay separate. A failed save leaves writing and the complete source packet downloadable.

## BDD and evidence

The existing APPLIED-LEARN-012 recovery clause is implemented for the local reader; this does not establish member-account integration or independent learning effectiveness.

| Scenario   | Executable evidence                                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| READER-030 | Six route/width cases visit all eighteen criteria, inspect the repair/lesson mapping, return with all six fields and self-check intact, and verify focused return. They also make and correct an actual practice mistake, return, edit the final revision and verify save/reload with its check cleared. |
| READER-031 | Five cases cover compatible old saves, three invalid context values, saved context/reload, route separation, failed save/download and unchanged stored bytes. Existing failure, departure-warning and earlier-notebook cases remain intact.                                                              |

Six expected missing-review failures were recorded before implementation at `86fa393`. The first complete run passed **124/124**. Author review then strengthened the six new round-trip cases to include a wrong answer and source-based correction; the exact final runner also passed **124/124**, with zero failures/retries. All 113 earlier case names and their executable code remain unchanged. All 114 prior BDD IDs remain, with READER-030/031 bringing the package to **116 IDs**; the application's L-series register is unchanged.

Static evidence confirms all prior generated fields and twelve source hashes, eighteen mappings, six malformed-authoring rejections, valid modules, formatting and local references. These focused local checks are not the full application gate, native persistence coverage or a production acceptance result.

Actual IAB rehearsal used the existing Everyday notebook. Its six writing fields survived the update unchanged. The author followed **Correct headcount → Lesson 3**, deliberately misclassified three claims, inspected their different explanations, corrected them, saved/reloaded while in practice, then returned to the exact same first/revised record with its self-check intact. The existing correct final plan was retained. Desktop and 390px views were inspected; the temporary viewport was reset and the final record explicitly saved. The earlier notebook remained byte-identical, SHA-256 `9ec2aba2510557a6e2344ec94987233e8097f67f8cb328eb66bb57c746742c81`.

Evidence directory: `/Users/tomwu/Documents/Codex/2026-10-28/dne-content-workflows-bdd/practice-return/`. It contains baseline/first/final reports, source comparisons, actual before/after values and downloads, screenshots, malformed-guidance checks, self-review and the local commit manifest. The author knew the sources and answer keys; this rehearsal is not an independent learner study.

## Next content action

An actual learner observation is now more useful than another speculative interface slice. Under #34, use the requested route/step feedback or unfamiliar learner attempt to identify the first confusing or unrealistic instruction, then revise that specific content with a before/after BDD example. No response has been invented. Preserve #93/#117's canonical/shared-reader work and keep production parked. Recommended lead: GPT-6 Sol / High; author content/evidence review High, separate Astra High only when requested or required.

Restart the dedicated preview, if it has stopped, from this checkout:

```sh
python3 -m http.server 56274 --bind 127.0.0.1 --directory assets/docs/learning-design
```

Use the reader's existing check command; append `--case READER-030` or `--case READER-031` for the corresponding scope. Retain the unpublished worktree and the current preview; no push, PR, full application gate, CI, merge or deployment was performed for this checkpoint.
