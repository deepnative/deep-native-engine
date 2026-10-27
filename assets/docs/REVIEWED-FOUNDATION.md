# Read and track the ordinary foundation lessons

The six version 2 lessons in the [27 October reviewed pack](PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) cover AI literacy, clear requests, checking outputs, privacy and rights, practical workflows, and participation. They are ordinary educational text for exploratory learners, professionals outside IT and IT practitioners. No employment, coding or paid plan is required. Reading is the primary format; this release supplies no audio/video or claimed transcript verification.

## Prepare the catalog deliberately

A current editor signs in through the existing staff entry and opens **Content workflow**. Select **Import the six reviewed lessons as drafts** and choose **Import six reviewed foundation drafts**. The import checks the six fixed source hashes and writes all six version 2 drafts together. It does not publish anything, rewrite version 1, create staff identities or grant privileges.

For each new version, the editor chooses **Submit for review**. A distinct current reviewer opens that exact version, checks its sources and rights, and chooses **Approve editorial review**. The editor can then choose **Publish reviewed lesson**. The source text and editorial review record support ordinary education; these buttons do not certify a reviewer, accredit a course or promise formal assessment. Original version 1 drafts keep their original qualified-signoff hold.

Repeated import of the same intact pack creates nothing further. A conflicting, partial, later or retired version refuses the import; inspect the staff list instead of replacing records. An unconfirmed request may have committed: return to the staff list to inspect the versions, and make a deliberate repeat only after checking. The application never automatically retries an import. Missing/changed pack files and stale staff authority do not yield a success message.

## Learn through the member screens

Choose a starting point and goal, then open **Learning library** or the current foundation recommendation. Search and open any of the six published lessons. Their suggested preparation is visible guidance, not a mandatory access barrier. Existing assignment prerequisites retain their separate enforcement.

Opening a lesson records **Opened in reader**. Choose **Start this lesson** when ready. Only after starting can you explicitly mark **Self-assessed complete**. This is your own learning report, not proof of understanding or qualified review. Optional study and practice remain deliberately chosen simulations using invented information; publication does not enable a live AI provider.

The library's private history and **View private learning activity** preserve exact lesson versions alongside existing exercise and assignment activity. Reloading or changing goals does not erase those facts. A cached return link to a replaced lesson refuses to open the replacement. Return to the library and deliberately choose the current lesson to record a separate opening. Retired versions retain their history and cannot be reimported into service. Another member starts with their own empty activity.

## Scope and evidence mapping

| Scenario              | Behavioral coverage                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| FOUND-01 / L230       | Fixed source hashes, six-draft atomic import, preserved originals, repeated import, conflicts and rollback                         |
| FOUND-02 / L230, L232 | Current editor authority, observed database lock waits, distinct source/rights review, premature publication and revocation denial |
| FOUND-03 / L231       | All six lessons for all three backgrounds; ordinary labels; separate opened/start/self-report states                               |
| FOUND-04 / L231, L232 | Private retained history, reload/goal changes, exact cached returns, replacement/retirement, CSRF denial and deliberate recovery   |

Executable cases live in `tests/unit/foundation-{pack,import}.test.ts`, the focused app/view cases, `tests/integration/foundation-import.test.ts` and `tests/e2e/foundation.spec.ts`. The database tests include actual commit followed by acknowledgement loss: the caller receives an unconfirmed result, inspection finds the whole pack and a deliberate repeat returns the existing versions without rewriting them. Browser cases use the real application runtime and normal member/editor/reviewer screens with a newly generated database and temporary loopback port per case. Their invented staff setup is separate from any hosted staffing decision.

The full approved suite, unchanged release-browser matrix and privacy controls remain required. #109 accessibility expansion and named VoiceOver acceptance are excluded by the 27 October owner direction; no qualified or full-MVP acceptance is inferred. #93 owns the content review record. #117 owns this importer/reader outcome. Tom's #97 member contribution consent/publication and #38 assignment intake are separate deliveries. Hosted publication requires an actual current editor/reviewer and the applicable deployment scope; tests do not enable it.
