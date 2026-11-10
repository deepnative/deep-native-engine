# Circle report outcomes

Issue [#196](https://github.com/deepnative/deep-native-engine/issues/196) RPTD-01–09. A report on a circle contribution now has its own outcome, separate from what happens to the contribution.

## For a moderator

On **Synthetic circle report worklist**, each report shows **Report disposition** and its revision. A report with no recorded action is **Open** at revision 1. With a current, finite grant for this exact circle, you can deliberately confirm one of these:

- **Ask for a local second look** (open reports only; reason: needs another look, or policy unclear). This records that the report needs another look in the same circle. Nobody is assigned or notified, and no response is promised. A later action may come from the same moderator.
- **Reject this report** (open or second-look; reason: no rule was breached, or not enough context). Only this one report is rejected as not actionable. Its contribution and every other report stay unchanged.
- **Close against decision revision N** (open or second-look; shown only when a hide or restore was recorded on the contribution at or after the report). This records that you inspected that exact decision. It doesn't claim the report caused it.

Rejected and closed are final, so a report has at most two recorded actions. Each form carries an original key: resubmitting the same form replays its result, while a changed action, a stale report or contribution revision, or a newer decision conflicts without writing anything. If a result is unconfirmed, **Check an original action key** with the **Report disposition** type reports whether it was recorded. New actions are refused when your grant has expired or been revoked, when the reporter has left the circle or withdrawn sharing, when the contribution is withdrawn or unavailable, or while discussion is paused.

## For the reporter

From your report receipt, choose **Inspect what happened to this report**. It shows the disposition, revision and each recorded action with its reason and time. **Download this report outcome** saves `circle-report-disposition.json` with `reportDispositionVersion: 1`, circle and report references, category, report time, disposition, revision and the structured actions. It contains no contribution text and no member or staff identity. Only you can open it, including after you leave the circle, withdraw sharing or the contribution becomes unavailable, until your account is deleted. Deleting your account removes the report and its outcome. It can't remove a copy saved on your device.

## Storage

Migration 134 adds `preview_circle_report_dispositions`: one immutable row per action, at revision 2 or 3, with structured action, reason, the moderator's internal reference and role, the contribution revision checked, the decision revision for a closure, and the original key and fingerprint. Database checks allow only the transitions above, require a closure's decision to be recorded after the report, and refuse updates. Rows leave with the report when the reporter's account is erased. Erasing the contribution owner's account leaves other members' reports and their outcomes in place.

This is an invented-data local and demo feature with finite test-purpose grants. It promises no staffed moderation, response time, independent or qualified review. The circle moderation contact remains info@deepnative.io.

## Evidence

| Contract                                                        | Evidence                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| RPTD-01–03 reject, second look, close against an exact decision | `tests/integration/circle-report-dispositions.test.ts`, store and route units, L333–L335 |
| RPTD-04 authority and isolation                                 | Integration (members, owner, unrelated staff, admin, revoked grant, other circle), units |
| RPTD-05 leave, sharing, source withdrawal, pause                | Integration and units; browser leave                                                     |
| RPTD-06 replay, conflicts, concurrent actions                   | Integration and units                                                                    |
| RPTD-07 original-key inspection                                 | Integration, route unit (unconfirmed result link)                                        |
| RPTD-08 database guards and erasure                             | Integration; browser erasure with stale download                                         |
| RPTD-09 three audiences on desktop and mobile                   | `tests/e2e/circle-report-dispositions.spec.ts` (L333–L335)                               |
