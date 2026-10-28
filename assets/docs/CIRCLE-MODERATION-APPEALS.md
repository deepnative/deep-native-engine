# Private circle decision reconsideration

In a deliberately enabled invented circle, open **Your contributions**, inspect your moderation notice, then follow **Request or inspect reconsideration of this decision**. An active owner can request reconsideration of the latest still-hidden decision while the contribution and its question remain shared under the current circle choice. Select a structured reason and confirm the exact decision. No contribution text, private exercise, assignment, evidence or explanation is copied into the request.

One request is retained per exact decision, with at most 200 retained requests per member in a circle. A repeated original form returns the existing request; changing its payload conflicts. An existing request, unavailable source, changed decision, write pause or retained limit prevents another request. A new later hidden decision can have its own request. Keep the original form key if a result is unconfirmed; inspect its authorized receipt before deciding what to do. An absent receipt is not proof that a previous write did not commit.

## Scoped reconsideration and the result

A currently and finitely granted moderator follows **Inspect reconsideration requests** from the existing circle report worklist. The grant must still apply to that exact circle and existing test purpose. A staff role alone gives no access. The worklist shows only currently eligible shared source and structured requests, without reporter identity or unrelated private work.

The moderator may uphold the decision with the recorded reason **rule applies**, or correct it with **decision corrected** and atomically restore the contribution through the existing moderation audit. The member sees the recorded result, time and resulting revision in the private request. Concurrent or stale forms cannot overwrite a newer decision or terminal result. A later source revision makes an earlier pending request non-actionable and explicitly superseded; it does not imply that staff resolved it.

Reconsideration may be performed by the original moderator. It is not independent review, qualified assessment, a promise of a human response or staffed appeal coverage. This local preview does not establish a real moderator, backup, contact or response SLA. No private paid-service or support queue is joined to these records.

## Withdrawal, history and erasure

Use **Withdraw reconsideration request** to withdraw a pending request. Its content-free record stays private, and staff cannot newly inspect or resolve it through the appeal worklist. A terminal result cannot be rewritten or reopened. Leaving the circle, withdrawing sharing or withdrawing the contribution's text removes staff source availability and never republishes old text. An unavailable or erased question also prevents a reply's restoration.

An active owner retains private inspection and **Download all your retained appeals in this circle**, including after leave, source withdrawal or a write pause. Pending withdrawal remains available during a write pause. Other members cannot inspect a request; their own history download contains only their own records. Expired, revoked, deleting or deleted accounts receive no retained request data or attachment.

The dedicated version-1 JSON download contains the complete bounded retained request history for that circle: own appeal/post references, exact decision revision/reason/time, structured request reason/time/state, current source state/revision, availability and any structured terminal result/time. It excludes bodies, reporter/staff identities, internal keys/fingerprints, workspace identifiers and other private learning or support data. It is separate from the general activity export; that export's version, sections and cursors are unchanged. HTML and JSON are not cacheable. Account deletion erases owned requests, results and their source audit. A copy already downloaded to a device remains outside server erasure.

## Behavior and evidence

| Scenario | Observable behavior                                                                                   | Checks                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| MODA-01  | Exact current owner requests reconsideration and receives a durable private record                    | Store/routes units; native HTTP; L248–250                                                        |
| MODA-02  | Duplicates, malformed input, wrong decision/owner, changed revision and retained limit fail safely    | Unit contracts; native uniqueness, 200-record bound and denial                                   |
| MODA-03  | Current finite exact-circle grant is required for available shared source                             | Unit authority faults; native grant/foreign denial and workspace lock wait; normal browser grant |
| MODA-04  | Uphold or existing atomic restoration creates one terminal result; replay and conflicts preserve it   | Unit transactions; native conflicting resolutions and audit integrity; browser result            |
| MODA-05  | Pending withdrawal, leave, sharing/source withdrawal and supersession never reshare or overwrite text | Native state/root-owner erasure cases; browser later decision and withdrawal                     |
| MODA-06  | Complete bounded own JSON, pause and lifetime rules retain privacy through erasure                    | Unit whitelist/faults; native guard/reapply/download/deletion; browser download/erase            |
| MODA-07  | Unconfirmed writes are inspected by original authorized key/current record without automatic retry    | Unit query/COMMIT/release/HTTP faults; native actual committed writes with lost responses        |
| MODA-08  | General, non-IT professional and technical members follow the normal journey                          | L248, L249 and L250 on desktop and narrow browser projects                                       |

The original native HTTP red expected the owner's reconsideration form to return 200 and received 404 after actual member/report/grant/hide setup. Original failures, component results, exact full gates, pre-push, author review, original PR/main CI and the dedicated main demonstration are recorded separately on [#196](https://github.com/deepnative/deep-native-engine/issues/196). This mapping and expected populations are not execution evidence. The parent remains open for its remaining original outcomes; no qualified, hosted or full-MVP acceptance follows from invented preview checks.
