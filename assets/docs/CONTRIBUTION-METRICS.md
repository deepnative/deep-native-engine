# Reviewed contribution metrics

[#122](https://github.com/deepnative/deep-native-engine/issues/122) adds `contribution-metrics-v1` to the operator snapshot at `/operator/metrics/report` and to the JSON at `/operator/metrics`. It counts committed contribution events and shows one editorial-outcome share. It does not measure instructional quality, verified skill or expert qualification. The snapshot remains a synthetic preview report, not a live business report.

## Events

Migration 088 adds `contribution_events`. Database triggers on `member_proposals` and `proposal_publications` record each event in the same transaction as the existing transition, so a rolled-back transition records nothing. The proposal and publication stores are unchanged. Events are immutable, and one revision has at most one event of each kind, so a replay or a later decision adds nothing.

| Event               | Recorded when                                                                                                    | Authority                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `submitted`         | The owner submits an exact rights-attested revision                                                              | member                                  |
| `reviewed`          | The revision's first editorial decision: changes requested, rejected (from submitted or quarantined) or accepted | moderator or platform administrator     |
| `accepted`          | A moderator or platform administrator accepts the exact revision                                                 | moderator or platform administrator     |
| `published`         | The owner shows the accepted revision to signed-in members (`member-display-v1`)                                 | member                                  |
| `source_withdrawn`  | The owner withdraws the proposal itself                                                                          | member                                  |
| `sharing_withdrawn` | Member display of a published revision ends, with cause `owner` or `source_change`                               | member, or `system` for a source change |

Reads, quarantine, drafts and automated output are not events. An event stores the proposal, revision, owner, workspace, kind, outcome or cause, acting authority, origin (`member` or `sample`), workflow version, display permission version, source table and source row, and time. It never stores proposal text, feedback, attribution, staff identifiers or credentials.

Measurement starts at the time recorded in `contribution_metrics_cutoff` when migration 088 runs. Earlier history is incomplete, not zero, and is not reconstructed.

## Disclosure

Only a current operator or platform administrator receives the aggregate. The HTML and JSON share one sanitized result from `src/contribution-metrics.ts`, and neither has filters or event rows.

- Member-origin and sample-attested contributions are separate groups. Member origin can still be invented preview data, so origin alone never establishes live activity.
- A group is suppressed unless at least 20 retained owners have submitted. A suppressed group shows no contributor, revision or event count, and does not reveal whether a value is zero.
- Each volume is a band of distinct revisions (`5-19`, `20-49`, `50-99`, `100-199`, `200+`), shown only when at least five distinct owners stand behind it. A prolific owner adds revisions but not owners.
- The first-decision acceptance share is revisions first accepted divided by revisions with a first decision, counting only revisions whose submission was also recorded after the cutoff. It is shown in 25-point bands, only when at least five owners are on each side. A later withdrawal or decision does not change a first decision.
- Repeated snapshots can still allow inference. This is a limitation, not an anonymity claim.

## Lifetime and export

Withdrawal keeps the minimal event history for the retained owner. Deleting the account or workspace cascades its events, so deleted accounts leave the counts. The member export is now `local-member-records-v32`, with an appended `contributionEvents` section listing the owner's own events. That section has the acting authority, never a staff identifier.

## Evidence

- Unit: `tests/unit/contribution-metrics.test.ts` covers the 19/20 contributor and 4/5 owner boundaries, band edges, the share complement, malformed aggregates and the report's rendering.
- Real PostgreSQL: `tests/integration/contribution-metrics.test.ts` covers CM122-01 to CM122-07. Six of the seven failed on `main` `2fd30a8` first; CM122-06 guards existing denial.
- Browser: journey L283 in `tests/e2e/contribution-metrics.spec.ts`.

Rollback: revert the application change and keep migration 088. The tables, triggers and the revocation marker in `revoke_changed_proposal_publications` do not change existing proposal behaviour.
