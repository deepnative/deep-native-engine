# Guided final practice

Checkpoint: 27 October 2026. Local content/workflow refinement under [#34](https://github.com/deepnative/deep-native-engine/issues/34), claim `DNE-2026-10-27-34-guided-final-practice-root`. Latest owner direction keeps production work parked. Lead recommendation Sol/High; author design and self-review High. No model switch or delegation.

## Observable workflow

The prior phone rehearsal placed a long source panel and the complete brief before six writing fields. The same Everyday book-swap, Work pilot and Technical investigation now use four freely available steps:

| Step                | What the learner does                                                                      | What remains available                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Read the brief      | Inspect the original task and source packet.                                               | Any other step, source reminder, earlier notes, save and download.                       |
| Write a first draft | Record task/check, request, repaired output, sharing choice and repeatable workflow.       | First-pass requirements in a disclosure; flawed teaching sample before the repair field. |
| Read the update     | Inspect later information against the retained first draft.                                | A read-only copy of the first draft; the editable original is still in step 2.           |
| Revise and check    | Keep a separate revision/reason, compare a worked record and make a deliberate self-check. | First draft, criteria and optional contribution practice.                                |

The source reminder is collapsed initially; at narrow widths the reference follows the main task. Steps never lock or automatically mark completion. Navigation preserves writing and its self-check. Editing first or revised writing clears the check; six nonempty fields enable it, but there is no automatic semantic grade. Downloads contain the complete packet, both drafts and the current step.

## BDD and compatibility

[READER-026–028](learning.feature) were recorded before runtime changes. Six READER-026 checks failed because the old page lacked `Final practice steps`. The [runner](checks.mjs) now covers six route/width journeys, one compatible older record, two invalid stage values, one failed save and one route-isolation/departure case. Existing checks navigate the visible steps; none forces a hidden control or drops its earlier behavior assertions. All 96 earlier case names remain. Both complete runs passed 107 cases with zero failures/retries; the second also checks forward/back navigation.

A validated optional `finalStep` stores an integer from 0 to 3 on explicit save. Missing values default to the brief in memory only. Loading/navigation does not rewrite the stored record. Invalid values use the existing protected-original recovery path. Stage navigation is excluded from the writing-change snapshot, so moving steps alone is not an unsaved-writing warning.

All twelve authored source hashes and content hash `5f8099258b1c5399d7ffc8cf29ebbfa63421fa04d04043a0f6b3d064cbe7925f` remain unchanged. New generated presentation fields reconstruct the prior instructions and complete source packets exactly. Existing lesson, feedback, contribution and capstone data remain exact. No automatic migration, new storage namespace, source retirement or copied old answers is introduced.

## Actual author rehearsal

Using the existing Everyday notebook at `http://localhost:56274/reader/`:

1. Downloaded the original current notebook and captured its six writing fields before changing the runtime.
2. Reloaded into the brief, visited every step and confirmed all six fields and the existing self-check were unchanged.
3. Opened the retained first draft beside the reply update; it matched the original field exactly.
4. Saved at the update step and reloaded there. Later saved at the draft step and reloaded there too.
5. Downloaded the new record: the only text change was the added final-step label. The earlier notebook download matched its prior bytes, SHA-256 `9ec2aba2510557a6e2344ec94987233e8097f67f8cb328eb66bb57c746742c81`.
6. Inspected desktop and 390 × 950 views. The first writing field appeared at approximately y=595, before the reference panel, without horizontal overflow. Reset the viewport afterward.

This rehearses the author's existing invented book-swap plan; it is not an independent learner study. The broader account, live AI, formal assessment and review-service criteria in #34 remain open. The actual browser tab is retained as the local deliverable.

## Reproduce and inspect

Reuse the dedicated server on port 56274 (PID 58717 at rehearsal). If it has stopped, from this worktree run:

```sh
python3 -m http.server 56274 --bind 127.0.0.1 --directory assets/docs/learning-design
```

Use `localhost` for the author notebook; `127.0.0.1` is a separate browser origin. The checks use fresh isolated Chromium contexts at the latter address, without an application database/provider or the shared gate port.

```sh
python3 assets/docs/learning-design/reader/build.py --check
node assets/docs/learning-design/reader/checks.mjs http://127.0.0.1:56274/reader/ <evidence-directory>
```

Baseline: `e4034a31248c8f73947bb2768cf20f12a10ad1bb`. Evidence directory: `/Users/tomwu/Documents/Codex/2026-10-27/dne-content-workflows-bdd/guided-final-practice/`. `red/results.json` retains six expected failures; `full-run-1/results.json` and `final-run/results.json` retain complete results. Before/after exports, values, earlier notebook, actual screenshots, source/ID/link checks and self-review are separate artifacts. The local commit manifest identifies the exact checked files and commit.

This checkpoint is local only. No push, PR, full application gate, CI, merge or deployment ran. The unpublished branch/worktree remains available. #93/#117 canonical/shared application scopes remain owned by their other worker.

Next bounded content action under [#34](https://github.com/deepnative/deep-native-engine/issues/34): give each final-practice writing field a short route-specific prompt, drawing from its existing first-pass instructions. The staged rehearsal still shows generic field labels/placeholders; learners must reopen the instruction disclosure to recover the exact reminder, update or investigation requirements. Preserve the three source packets, alternative valid solutions, first/revised writing and notebook compatibility. Preserve #93/#117 canonical/shared-reader claims and recheck live ownership before starting. Lead Sol/High; author design/self-review High. Production remains parked.
