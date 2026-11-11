# Private sample practice conversations

Scoped delivery: [#424](https://github.com/deepnative/deep-native-engine/issues/424), advancing #200/#34.

Members explicitly opt into invented-text-only practice from an eligible current published synthetic lesson. A conversation pins the exact source version, learning goal and repository prompt version. Each accepted response is paired with a stored deterministic comparison and bounded source excerpt. The initial instructions do not count toward the limit of 30 visible turns: at most 15 response/comparison pairs. These prompts are simulated and unreviewed, express uncertainty and cannot judge competence. No provider, job, paid quota, entitlement or ledger is invoked. Existing one-note practice remains available separately.

Owner history remains available after goal changes or source retirement. A submission overlapping publication of a replacement version may complete against the exact source that was eligible when it was read; subsequent submissions must use current eligibility and cannot continue the replaced source. This preserves the pinned history without silently retargeting a response. New pairs require the same current goal and eligible exact source/template; the application does not silently retarget a conversation. Exact duplicate response submissions replay their original pair; conflicting submissions cannot overwrite it. Withdrawal removes every response-derived byte and leaves a content-free marker that prevents reopening the same slot. Account deletion cascades all owned sessions/exchanges.

History has bounded keyset pages, and a detail has at most 15 pairs, or the limit an administrator set in the student's coaching terms when the conversation started (1 to 50, #823; see [STUDENT-COACHING-TERMS.md](STUDENT-COACHING-TERMS.md)). Structured member export includes all retained session metadata and exchanges through the existing authenticated 100-record/256-KiB pagination. Practice delivery introduced payload `local-member-records-v13` with these two sections; the current support addition uses v14 with later appended sections; cursor v2 preserves existing section indices. Pages remain live reads, not one immutable snapshot across requests.

## Return to saved practice (#499)

From the learning dashboard or private learning activity, choose **Saved practice
sessions** or **Saved practice notes**. These entries remain available even when
there is no matching published lesson for the current goal. History pages and
session details include **Return to learning**. Opening history never starts a
session, saves a note, marks completion or grants access. The existing exact-source
and owner-only readers still control retained content and whether appending is
available; an unavailable source remains read-only.

BDD mapping: PRACTICE-RETURN-01 → L103 (dashboard, exact-session resume/append/reload);
PRACTICE-RETURN-02 → L103 (empty histories and no records created);
PRACTICE-RETURN-03 → L104 (goal/source changes, owned return and other-member denial);
PRACTICE-RETURN-04 → L58 with L81 regression (saved/retired notes and withdrawal).
Existing Vitest view tests check discovery before potentially long assignment
lists and keep history separate from completion. Existing PostgreSQL readers and
L105 export/withdrawal checks remain unchanged. Approved journey IDs and
register denominators are preserved. Record revision-specific results on #499;
this mapping itself is not delivery evidence or parent/full-MVP acceptance.

Navigation rollback requires only reverting the view change; there is no data
migration or mutation to reverse. Preserve the existing readers and stored work.

## Optional interview practice (#200)

The practice start page now offers a second, optional choice after the ordinary practice: **Optional interview practice**. It uses its own immutable prompt version, `interview-practice-v1`, for the same eligible lesson. Each goal has its own wording (everyday, work, build), each asks an invented interview question, and none names a job title, employer or career. Only the member's own start chooses it. Background, goal and plan never do.

Because sessions are already keyed by member, exact source version, goal and prompt version, an interview session is a separate session beside the ordinary one and needs no migration. Everything else is reused unchanged: the 15-pair (30 visible turn) cap, exact replay and conflicts, freezing on a goal change or replaced or retired source, withdrawal, export, account erasure and, when `DNE_PRACTICE_SESSION_ALLOWANCE` is on, one test unit per new session.

Each saved comparison in an interview session is the same deterministic comparison with one more line: "This interview practice doesn't predict hiring, interview results or competence." There's no score or rating. The session page names its purpose, and history shows "Optional interview practice" or "Lesson practice" with the prompt version. The export already carries `promptVersion`, which tells the two apart. No AI provider is called.

BDD mapping: INTERVIEW-01..07 are in `tests/unit/practice-sessions.test.ts`, `tests/unit/practice-session-ui.test.ts`, `tests/unit/member-wording.test.ts` and `tests/integration/interview-practice.test.ts`. INTERVIEW-08 is journey L315 (desktop and mobile Chromium).

Rollback: revert the code. Interview sessions already saved keep their history, export and withdrawal, because an unknown prompt version is read-only.

Still open on #200: a live provider, metering and budget exhaustion. Simulated suggestions from the local test provider are below.

## Simulated AI suggestions on a saved pair (#200)

Under each saved pair, a member can choose **Ask for a simulated AI suggestion**. It is optional, and saving or reading a pair asks for nothing. The suggestion comes from the local deterministic test provider on this service, not a live AI service. Nothing is charged, no test unit is used and no person reviews it.

A suggestion is kept only if it passes every check in `src/practice-ai-suggestions.ts`. Otherwise it is rejected whole, with nothing repaired or partly shown:

- it starts "Simulated AI suggestion, not reviewed by a person.";
- it quotes the member's own saved words exactly, once, and at least the start of their first line;
- it cites the session's exact source and version, such as `SYN-001 v2`, and no other;
- it says it is uncertain and that it gives no score, and in interview practice it also says it predicts nothing;
- outside the member's quoted words it has no digits, percentages, links, markup, ratings or competence words, and it fits on one line of up to 1,200 characters.

| What happens                                                 | Result                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| A grounded suggestion comes back                             | It is saved with the pair and shown after reload.                                                      |
| The output fails a check                                     | The pair says the suggestion was rejected. Nothing from it is kept, and it isn't requested again.      |
| The provider fails or doesn't answer within 5 seconds        | The outcome is unknown. The request stays held and counted, and it isn't retried.                      |
| The same pair is asked again, even at the same moment        | The session lock lets one request through. The others return its result, with no second provider call. |
| Simulations are paused (`/operator/local-ai`)                | Nothing is requested and the page says they are paused.                                                |
| The member already has 3 unfinished AI requests (#190)       | Nothing is requested. Practice suggestions and sample requests share this limit.                       |
| The source or goal changed, or the prompt version is unknown | Nothing is requested. Earlier suggestions stay readable.                                               |
| Another member, or no member, asks                           | Refused like an unknown session; nothing is requested.                                                 |
| The session is withdrawn, even while the provider answers    | The pair and its suggestion are removed and nothing is kept.                                           |

Migration 121 adds `practice_ai_suggestions`: one row per pair, removed with the pair or the account. A database trigger accepts a new row only as its owner's own pending request for a practice-suggestion job, and lets it complete once, as ready or rejected. The request is an ordinary member-owned AI job (`practice-suggestion-local-v1`, one attempt), so the member's export already lists it under `adapterJobs`. Download my records (v43) adds `practiceAiSuggestions`: state, text and times, labelled simulated, without the request fingerprint or provider reference.

Limits: an administrator can assign a held unknown request to an operator for the same content-free [hold inspection](PRIVATE-LOCAL-AI-HOLD-INSPECTION.md) as sample requests (#189). It shows the request's status, times and versions, never the member's words or the suggestion. Recording a test outcome for it isn't available yet, so it keeps its place in the limit. Metering, a spending ceiling, a live provider and qualified review are still open on #200.

BDD mapping: PRACTICE-AI-01..07 are in `tests/unit/practice-ai-suggestions.test.ts`, `tests/unit/practice-session-suggestions.test.ts`, `tests/unit/member-export.test.ts` and `tests/integration/practice-ai-suggestions.test.ts`. PRACTICE-AI-08 is journey L326 (desktop and mobile Chromium).

Rollback: pause simulations to stop new requests, then revert the code. Keep migration 121; saved suggestions stay in the table and its export until withdrawal or account deletion.

## Failure and rollback

Failed or uncertain writes return generic non-success and never replay automatically. Reload owned history to inspect actual durable state. Expiry, revocation or deletion during lock waits denies or rolls back; a failed rollback discards the connection.

Before any data exists, revert the feature and additive migration together. After data exists, keep schema and owner read/export/withdrawal and disable start/append if rollback is required. Running an older binary that omits session portability is not a complete rollback.

## Evidence boundary

L103–L105 extend approved local browser coverage to opt-in/multiple response/reload/cap, isolation/unavailable-source history, and export/withdrawal across three backgrounds on desktop/mobile. This changes the local register from 102 to 105 journeys; existing IDs and mandatory variants remain. Full-MVP acceptance, qualified curriculum review, live AI and paid-service criteria remain separate open requirements on #200/#34. Record actual verification results in the issue/PR before delivery closeout.

## Session lifetime and uncertain replies (#453)

Practice source, start, history, detail, response and withdrawal operations use the
same bounded transaction boundary. Principal, workspace, source and session locks
retain their existing order. PostgreSQL validates remaining authority after the
principal lock and again before commit; monotonic elapsed time includes query
transit, commit reply and native connection handback. A delayed reply cannot extend
an expired session's authority or expose its private result.

The whole operation has a 10-second budget, acquisition at most 3 seconds and each
query/commit/known rollback at most 5 seconds, further restricted by remaining
operation and authority time. Server statement and lock timeouts remain 5 seconds;
the transaction timeout uses the remaining operation budget. Missing or malformed
clock evidence fails closed. A connection acquired too late is discarded. An
unresolved operation is never followed by a queued rollback or automatic replay;
its owned connection is discarded. Known rollback is bounded. Native release is
synchronous and cannot be preempted, but its elapsed time is checked before returning
any result.

A denied or unavailable response does not prove a submitted write was undone.
A successful PostgreSQL commit can outlive its acknowledgement. Re-establish valid
member authority and inspect saved history before deciding what to do next. The
server does not automatically resubmit the write. Published source/goal/prompt
pins, replay/conflict semantics, pair limits, withdrawal and export remain unchanged.

No schema or retention policy changes are needed. To roll back safely, pause the
affected practice operations while retaining their stored records and existing
export/deletion paths. Restoring the older transaction reader also restores the
known expiry defect; it is not a privacy-preserving recovery. This local correction
does not establish hosted deployment, live AI, paid capacity or qualified review.

## Practice interview with a coach (#201, first slice)

Delivered for part of [#201](https://github.com/deepnative/deep-native-engine/issues/201) (COACHMOCK-01 to COACHMOCK-06, browser journey L324). The first page of `/practice-sessions` ends with a **Practice interview with a coach** section. It reads the delivered sample coaching holds ([CTP-012 member sample holds](CTP-012-MEMBER-SAMPLE-HOLDS.md)) and changes nothing.

- It says the sessions listed are simulated practice that no person reads, and their comparisons don't come from a coach.
- It says no coaches are available to book yet, so a practice interview with a person can't be arranged. This follows the owner's 9 November 2026 decision that there are no real experts yet, and shows whatever the member's minutes or the check result.
- Without a current coach-minute test grant that has 60 free minutes, it says a practice interview with a person needs coach minutes, foundation membership doesn't include them, practice-session units can't be used instead, and no coach is booked. It offers no request link. Background, goal, review minutes and practice-session units never change this.
- With such a grant, it links to the sample coaching windows and says a sample hold isn't a booking: no coach has confirmed it and nothing is paid.
- It lists the member's own coaching sample holds, newest first, each as "Sample hold with a coach · not a booking", with its exact UTC window and state (held until its deadline, withdrawn, or ended without a booking), linking to its receipt. Formal-review holds and other members' holds don't appear.
- If the check fails, the history still loads and the section says it couldn't check. Later history pages leave the section out.

There's no migration, write path, booking, coach, quota or payment. Real coaches, accepted service terms, a funded coach quota, booking confirmation, cancellation, no-show and attributed coach feedback are deferred to [#784](https://github.com/deepnative/deep-native-engine/issues/784) and need the owner's decision. To roll back, remove the section from the history page. No data changes.
