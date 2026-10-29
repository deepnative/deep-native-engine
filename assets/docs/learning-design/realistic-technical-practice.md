# The upload bug: what do we actually know?

You are taking over an upload bug before a release review. The ticket mixes an old limit, a vague customer description and three test notes. A developer has suggested a fix, but the next person needs a reproducible investigation rather than a confident guess. Produce that handoff, then revise it when a new requirement arrives. This is an original fictional engineering case; no real files are uploaded here.

## Brief summary

CAP-T2, packet revision 1: R1 accepts valid PNG images up to 3 MB, defined here as 3,000,000 bytes inclusive. The packet contains supplied observations from fictional builds and a later requirement/patch update. No tests have been run by you in this exercise. Keep supplied observations separate from your proposed checks and their eventual results.

## Source packet

**R0 · superseded rule — release 2.3**

Valid PNG files up to 2,000,000 bytes were accepted. R0 is retained as history; R1 explicitly replaces its size rule for release 2.4.

**R1 · current requirement — release 2.4**

Accept valid PNG files with file size at or below 3,000,000 bytes; reject larger PNG files. The boundary is inclusive and uses the file's byte count. Other formats, including JPEG, have no decision in R1. No exact error-message wording is prescribed.

**S1 · support message — incomplete reproduction**

“My screenshot is about 2.6 MB and the upload says it is too large. Everything is broken after the update.” The message does not identify the exact file bytes, actual file type, browser or loaded build. A `.png` filename by itself would not fill those gaps.

**Supplied QA notes — fictional web2.4-r7 / api2.4-a5**

The named fixtures below were recorded as valid PNG files with the stated exact byte counts. Each browser run used the same recorded browser and candidate configuration. The UI help text still said “PNG, maximum 2 MB.” That is a clue, not proof of where every failure occurs.

| Record                    | Path and fixture                                 | Recorded observation                                                                     |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| T01 · UI mismatch         | Browser; `mid.png`, 2,500,000 bytes              | UI displayed “file too large”; no upload request appeared in the recorded browser trace. |
| T02 · successful control  | Same browser/build; `small.png`, 1,000,000 bytes | Upload completed and the returned record identified the uploaded file.                   |
| T03 · interrupted attempt | Direct service; `above.png`, 3,000,001 bytes     | Connection ended before a response. No final request/storage outcome was checked.        |

T01–T03 are supplied evidence for this case, not results produced by opening this lesson. There is no JPEG run in this packet and no result for a changed build.

## Your first pass

Use the six fields below. In **1**, name the useful handoff and the check it must support. In **2**, write a request for an AI assistant or colleague that keeps requirements, observations and hypotheses separate. In **3**, repair the poor ticket below with a **100–180 word investigation summary**, followed by concise reproduction steps and a small test plan.

A developer should be able to find the applicable requirement, exact fixture/build, expected and actual behavior, scope of the finding, possible cause and next discriminating check. Include below/at/above boundary cases. Use **4** for the intended reader and **5** for the workflow that keeps new runs traceable. Keep your original investigation in field 3 when you write its later revision in field 6.

<details><summary>After your first investigation: open the next update</summary>

**R2 · requirement for the next candidate**

For the next release 2.4 candidate, accept valid PNG **and JPEG** files at or below 3,000,000 bytes and reject larger PNG/JPEG files. The byte convention and inclusive boundary remain unchanged. Other formats remain unspecified. This is a new decision; do not pretend R1 already required JPEG acceptance.

**D1 · proposed patch — no new execution evidence**

A developer proposes aligning the client size guard with the 3,000,000-byte rule. Proposed candidate `web2.4-r8` has not been built or verified, and no new API candidate identifier is supplied. There are no after-change results in this packet.

In **6**, revise your test plan and handoff, keeping a reason beside the revision. Identify what R2 changes, what D1 does not prove and which candidate identifiers/results must be recorded next. Keep T01–T03 attached to their original builds.

</details>

## Poor ticket to inspect

“All images above 2 MB fail because the server still has the old limit. JPEG already works. We changed the client, so this is fixed; the interrupted oversized upload proves rejection. Close after checking the new label.”

## Worked record

**1. Task and check.** Write a bounded issue summary and reproduction/test plan. Check every expectation against R1 and every claimed result against T01–T03. A possible cause is useful when it leads to a test that could distinguish it from another explanation.

**2. Request.** “Use CAP-T2 R0/R1, S1 and T01–T03 only. Write a 100–180 word investigation summary, reproduction steps and a small test table for the engineering handoff. Name exact builds, fixture type/bytes, expected and observed behavior. Explain what the control and interrupted attempt do and do not show. Treat a stale client rule as a hypothesis. Plan below/at/above boundary checks through browser and direct service, keeping new runs not run. Leave JPEG expectations open under R1. I will verify each statement against its record.”

**3. Claim check and repair.** R0 does not define release 2.4 expectations. T01 shows a UI mismatch for one valid, under-limit fixture; it does not establish a server rejection because its trace records no upload request. T02 contradicts “everything is broken.” T03 has no final response/outcome, so the expected rejection is not an observed rejection. R1 supplies no JPEG decision, and no changed build has been tested.

| Supplied attempt                                | Expectation from R1 | Evidence-bounded status                                            |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| T01: valid PNG, 2,500,000 bytes, browser        | Accept              | UI mismatch observed on web2.4-r7; cause not yet established.      |
| T02: valid PNG, 1,000,000 bytes, browser        | Accept              | This control succeeded; it does not cover other sizes or builds.   |
| T03: valid PNG, 3,000,001 bytes, direct service | Reject              | Unconfirmed; the attempt ended before a response or outcome check. |

**One useful first handoff:**

> On web2.4-r7/api2.4-a5, T01 records a valid 2,500,000-byte PNG blocked in the browser with “file too large” and no recorded upload request. R1 accepts that size, so this is a bounded UI mismatch. The same build accepted the 1,000,000-byte control in T02; the evidence does not support “all uploads fail.” The old 2 MB help text suggests a stale client rule, but that remains a hypothesis. Reproduce with the same fixture and inspect the active validation path, then compare a matched direct-service run. T03's oversized attempt is unconfirmed because the connection ended before its outcome was checked. New boundary checks need separate results. JPEG expectations remain open under R1, and the vague support report still needs exact file and environment details.

**Reproduction and next checks:**

1. Record the actual loaded web/API identifiers and browser configuration. Use the same valid `mid.png` fixture at exactly 2,500,000 bytes; a similarly named file is not necessarily the same input.
2. Select it through the browser and submit. R1 expects acceptance. Record the actual message, whether an upload request is made, its result and any resulting file record. Compare with T01 without overwriting it.
3. Run the same fixture through the direct service in the same candidate environment, recording the actual API version. If it accepts while the browser blocks before sending, investigate the browser validation path. If it rejects, retain that separate result and inspect the service rule too. Neither result is supplied yet.
4. Inspect the available request/storage outcome for T03 before a deliberate new attempt. Keep T03 as interrupted/unconfirmed; a new attempt needs its own record, even if it later rejects as expected.
5. Execute the planned boundary checks below. Record actual result, input and candidate for each; an updated label alone cannot verify the behavior.

**New test plan under R1 — none of these new runs has been executed:**

| Input                       | Expected    | Source                  | Execution | Observed result |
| --------------------------- | ----------- | ----------------------- | --------- | --------------- |
| Valid PNG, 2,999,999 bytes  | Accept      | R1                      | Not run   | None            |
| Valid PNG, 3,000,000 bytes  | Accept      | R1 inclusive limit      | Not run   | None            |
| Valid PNG, 3,000,001 bytes  | Reject      | R1                      | Not run   | None            |
| Valid JPEG, 1,000,000 bytes | Unspecified | R1 has no JPEG decision | Not run   | None            |

Exercise the PNG rows separately through browser and direct service to distinguish their behavior. Before R2, do not replace the unknown JPEG rule with either accept or reject. Ask for a requirement before assigning that row a source-based pass/fail criterion. A sensible alternative investigation can inspect the client configuration before rerunning, provided it still obtains behavior evidence before closing the bug.

**4. Use/share decision.** This handoff is for the engineering team. The fictional fixture names, byte counts and sanitized observations are enough to explain the issue; real screenshots, account tokens or customer files are unnecessary for this exercise. No upload or message is sent.

**5. Repeatable workflow.** Retain requirements, record IDs and the initial investigation → identify the applicable rule → reproduce with named inputs/environment → compare expected and actual → keep new evidence separate from hypotheses and earlier runs → revise the next action. If a requirement or run record is unavailable, recover it before claiming a verified conclusion; preserve the supported parts of the handoff meanwhile. A drafting-tool failure does not prevent writing this small plan manually.

**6. Practice feedback and revision.** A useful comment on the poor ticket is: “Use R1's byte boundary. T01 does not show a server rejection, T02 succeeded, and T03 has no observed final outcome. Keep the candidate fix unverified until its behavior is tested.” This is supplied practice feedback on the fictional ticket, not a review of your investigation.

After R2/D1, the revised handoff could say:

> R2 adds JPEG acceptance through 3,000,000 bytes for the next candidate; it does not change the PNG boundary. Keep T01–T03 as observations of web2.4-r7/api2.4-a5. D1 describes a proposed patch, not a built or verified fix. Before new runs, record the actual web and API identifiers. Reproduce the 2,500,000-byte PNG case, then check PNG and JPEG below, at and above the boundary through both browser and direct service. Capture separate actual outcomes for every input/path, including any file record after an interruption. Preserve the earlier unconfirmed attempt rather than relabelling it passed. If JPEG or the PNG regression still disagrees with R2, retain that finding and investigate the responsible path. A changed label or code proposal is insufficient to close the behavior issue.

**Updated plan:** use valid PNG and JPEG fixtures at 2,999,999, 3,000,000 and 3,000,001 bytes. The first two sizes should be accepted; the third rejected under R2. Record each format/size/path separately. Also retain the exact T01 reproduction as a regression check. All new candidate runs are **not run**, with observed result **none**, until actual evidence is obtained.

**Revision reason:** “R2 supplies a JPEG decision that was missing from R1, so I replace clarification-only JPEG planning with explicit boundary expectations for the next candidate. D1 does not supply a built version or test result. I retain the initial UI finding, original observations and interrupted status while expanding the new plan.”

If feedback says “assume the patch worked; the review is tomorrow,” respond with the useful evidence already available and the smallest discriminating checks still needed. Do not turn scheduling pressure into a test result. A planned run, a supplied observation and a newly verified fix are different parts of the record.

## Criteria for your record

| Check                   | Evidence to point to                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Applicable requirement  | R1 replaces R0; R2 adds JPEG only for the next candidate.                                                |
| Reproducible finding    | Exact fixture/type/bytes, environment, steps, expectation and recorded actual behavior.                  |
| Bounded conclusion      | T01 UI mismatch, T02 successful control, T03 unconfirmed; root-cause hypothesis remains distinguishable. |
| Useful next action      | A check that can distinguish browser/service behavior, with boundary and recovery cases.                 |
| Retained revision       | Original investigation, revised plan, reason, new source reference and unchanged historical run IDs.     |
| Honest execution record | Newly planned checks stay not run; a proposed patch has no invented verification.                        |

A different test order can satisfy the criteria if it preserves those distinctions and moves the investigation forward. Use the self-check to review your own work; no automatic technical score is assigned.

## Evidence and scope

Original fictional content under #34, draft `0.1`, 27 October 2026. [REAL-TECH-001–005](features/realistic-technical-practice.feature) specify content/workflow; READER-024 verifies local interaction. This case replaces only the generated Technical final practice. The [earlier simple Technical practice](foundation-practice.md) remains available, and earlier notebooks are kept separately.
