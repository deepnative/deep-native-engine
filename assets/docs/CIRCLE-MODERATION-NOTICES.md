# Private circle moderation decision notices

In a deliberately enabled invented local circle, open **Your contributions**, then **Inspect this contribution's moderation notice**. The page shows your contribution's current retained state and revision, and the latest recorded hide or restore decision's reason, revisions and time. A contribution without a decision says so. **Download this latest-decision snapshot** saves the same bounded information as JSON.

This is a private snapshot of one contribution's latest decision, not a complete decision history, an appeal or a promise of human review. The preview has no appeal request or appeal-review service, staffed moderation, response-time promise or qualified judgment. The wider ordinary moderation and appeal outcome remains open in [#196](https://github.com/deepnative/deep-native-engine/issues/196).

## Privacy and retention

The notice contains only its format version, your circle and post references, current post state/revision, and the latest decision's action, bounded reason, old/new revisions and time. It excludes contribution bodies, reporter/staff identities, credentials, replay keys and other private learning or support material. HTML and JSON responses are not cacheable; the download is an attachment with a fixed filename.

An active owner can inspect a retained notice after leaving the circle, withdrawing sharing or withdrawing the post, and while discussion writes are paused. Those reads never restore sharing or republish withdrawn text. Other members and staff credentials cannot read it. An expired, revoked, deleting or deleted account cannot use the notice route.

No new notice rows or free-text copies are retained. The page reads the existing account-owned moderation audit; account deletion erases that audit with the owned contribution. A JSON copy already downloaded to your device remains under your control and cannot be erased by account deletion.

## Existing circle rules

Use invented information only. Keep personal, client, private assignment and evidence text out of shared contributions. Keep discussion respectful and relevant, and report the exact shared item for privacy, conduct or off-topic concerns. A current moderator needs a finite grant for that exact circle to hide or restore a contribution. The existing sharing policy and grant purpose are unchanged; joining alone never grants sharing consent or staff powers.

## Behavior and evidence boundaries

| Scenario | Observable outcome                                                                                 | Executable checks                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MODN-01  | Owner inspects latest hide/restore or honest no-decision state                                     | Circle store/routes unit checks; `circle-moderation-notices.test.ts`; L245–247                           |
| MODN-02  | Other members, staff, invalid references and inactive accounts receive no notice                   | Unit/native denial and lifetime checks; browser cross-member denial                                      |
| MODN-03  | Leave, withdrawal and write pause preserve private reads; deletion erases retained audit           | Native state/deletion-lock checks; browser leave/withdraw/delete paths                                   |
| MODN-04  | Bounded JSON has the same authority and no body/identity/key; uncertain reads return no attachment | Unit projection/DB/commit/release failure checks; native counts and JSON; actual browser download        |
| MODN-05  | Ordinary rules and retention/appeal limits work for every background                               | Unit rendering; L245 explorer, L246 professional and L247 technical, desktop and narrow browser projects |

The original native HTTP test demonstrated the missing owner route with an expected 200 and actual 404 before implementation. Component checks, full verification, exact-commit pre-push checks, original CI, resulting-main evidence and the dedicated demonstration are recorded separately on #196. Scenario definitions and expected populations alone do not prove execution. Invented preview evidence does not establish qualified review, hosted acceptance or full-MVP completion.
