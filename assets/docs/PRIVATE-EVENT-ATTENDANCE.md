# Private local rehearsal attendance

A member can deliberately permit one selected local administrator to record that they observed the member present in an invented rehearsal. Registration alone does not grant that permission. This is a human-authored local observation, not a qualified assessment, course completion, attendance at a real clinic or paid service.

## Use the member and staff journey

In the dedicated demo/test environment, enable `DNE_LOCAL_STAFF_ENTRY`, `DNE_EVENT_REGISTRATION` and `DNE_EVENT_ATTENDANCE`. Attendance defaults off and is unavailable in live mode. Use existing finite trusted administrator setup and sign in at `/staff/sign-in`; **Private rehearsal attendance** shows only that administrator's own noncredential reference. There is no member or staff directory. Never share a staff sign-in credential.

Schedule a dated invented rehearsal using [the existing scheduling flow](PRIVATE-EVENT-SCHEDULING.md), at least two minutes ahead of the actual PostgreSQL clock. The member discovers and registers through their own browser, opens **My private attendance receipt**, enters the selected administrator reference, checks the exact registration and finite window, then explicitly confirms the unchecked permission. Its deadline is bounded by event end, current member/administrator authority and one hour from the original database-observed request; it cannot be renewed in place.

Share only the permission reference with that selected administrator. During the genuine event and permission window, the administrator uses their staff tools to check the reference and deliberately confirms a present observation. The server records one immutable PostgreSQL-timed fact. An early request denies; opening a page never records attendance. The owner can reload their receipt, private history and export. Missing data says **No observation recorded**, never absent, completed or assessed.

## Withdraw, remove and recover

**Withdraw attendance permission** stops protected staff access while retaining the owner's fact and registration. **Check removal of my observation** followed by a separate unchecked confirmation deletes the exact observation and identifying attendance permission links, retaining enrollment. Registration withdrawal/cancellation also fences staff access; a new registration requires its own fresh deliberate permission. Owner erasure removes owned facts. Staff erasure anonymizes attribution without transferring access. Removal cannot recall an earlier authorized capture or promise hosted-backup deletion.

An unavailable reply may already have committed. Keep the original instruction and recovery reference. **Inspect original result in a new tab** performs a fresh authorized read while preserving the original uncertain form; private POST pages cannot safely be replayed using browser Back. Only after inspection, choose whether to explicitly repeat the same instruction with the original key. Confirmation starts unchecked. The application never automatically retries, substitutes a key, renews a deadline or restores removed content. A missing inspection is not proof an earlier request failed or cannot finish.

## Compatible pause and data

Disable `DNE_EVENT_ATTENDANCE` and restart the current compatible runtime to pause new permissions and observations. Keep local staff entry available for separately current finite inspection. Owning receipts/history/export, withdrawal, exact removal, erasure and original-key inspection remain available; no new authority is invented. Disabling registration also prevents new enrollment. Migration066 is additive and reapplicable to populated data; it creates no historical attendance. Rollback is creation pause, not a destructive down migration or an assumed older-binary downgrade.

Trusted learning templates stay in Git. Exact registration permissions, observations and structural operation reservations stay in PostgreSQL. Export v25 appends permission/observation sections39/40 after existing37/38, preserving cursor v2 and100-record/256KiB bounds. Exports use generic administrator attribution, omit administrator directory references/credentials and recheck current ownership on every page. Anonymous key reservations prevent erased operations from reviving authority.

Issue [#490](https://github.com/deepnative/deep-native-engine/issues/490) holds ATTEND-01–08 acceptance and revision-specific evidence, including retained failures; see [the executable map](PRIVATE-EVENT-ATTENDANCE-EVIDENCE.md). Local tests and demonstrations do not establish deployment, qualified review or full-MVP acceptance. Parent [#119](https://github.com/deepnative/deep-native-engine/issues/119) retains its broader clinic, staffing, recording and commercial criteria.
