# Workflow template re-review, 10 November 2026

Issue [#774](https://github.com/deepnative/deep-native-engine/issues/774). This record releases WF-001, WF-002 and WF-003 as **version 3**. It is the first monthly re-review under [#48](https://github.com/deepnative/deep-native-engine/issues/48). It extends the [27 October editorial record](PLAN-004-EDITORIAL-REVIEW-2026-10-27.md); version 1 and version 2 stay unchanged.

## Who reviewed and approved

- **Comparison:** Claude Code (Claude Opus 5.5) for @netcsc, prepared on 9 November 2026 ([comparison on #774](https://github.com/deepnative/deep-native-engine/issues/774#issuecomment-6749254037)).
- **Approval:** the owner, on 10 November 2026: "approved", with the proposed front matter and wording unchanged and `next_review` 2026-12-10. Recorded on #774.
- **Release:** Claude Code for @netcsc, claim `DNE-2026-11-10-774-v3-release-worker-z`.
- No human expert sign-off is claimed.

## Sources re-read on the release day (10 November 2026)

| Source                                                                                                                                                                                  | Cited by       | State on 10 Nov                                  | Change since the 9 Nov comparison |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------ | --------------------------------- |
| [OpenAI Help Center, prompt engineering best practices](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api)                          | WF-001, WF-003 | "Updated: 21 days ago". Rules 1–7 as compared    | None                              |
| [OWASP Authentication Cheat Sheet, authentication and error messages](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages) | WF-002         | Last upstream commit still `684d6d9`, 4 Oct 2026 | None                              |

## What changed in version 3

**Metadata:**

- `reviewed_on` and `last_verification` are 2026-11-10. The verification is a manual input/output comparison against current sources; no AI call or software test was run.
- `next_review` is 2026-12-10.
- `readiness` now says the template is served read-only at `/workflows`.
- `reviewer` names this release claim and the owner's approval.
- `sources` adds this record.

**Body:**

- **WF-001:** the request puts the instruction first and delimits the brief with triple quotes. It lists missing venue, contact, retention and publication details as open questions instead of saying "do not invent".
- **WF-002:** the request gives every case the status **not run**, and writes "password rule needed from the product owner" when the brief has none. The row 3 revision also compares status codes and response time, not only the visible message. Row 4 adds why the password rule belongs to the product owner.
- **WF-003:** the request keeps "next Tuesday" as written and leaves any draft message unsent for a person to approve.

Unchanged: invented inputs, the hand-authored example outputs, rights and licence, owner, prerequisites, permissions, cost, supported environment, limitations, accessibility, and the human-review and failure paths. Each v3 file was re-checked by hand against its own invented input: the example outputs still trace to it.

## Reviewed asset bytes

SHA-256 of each exact file, including metadata. Version 2 hashes are unchanged from the 27 October record.

| Asset  | Version 2 SHA-256                                                  | Version 3 SHA-256                                                  |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| WF-001 | `9b7060f989efb8bb6bb7305ae3245d7662488d9bc7c2ea54726ed3374e12473d` | `064e55f160a956d1d1f44a14b0ab02b85e2878a3c3d8dba1a918e8cb21aee9c9` |
| WF-002 | `57c5db349ce75d64bb51056a4d2c390b3773839dd6812806a963c9d324bd9103` | `e3b2d5a7921b331f1ae51c443190e0d2bed6f79aac45f3a412d133311cabf127` |
| WF-003 | `85d4e33a914c0209bfb253046693f942075a792d6bb6f68d864b8822190ebedd` | `f5318bd93a02b03caae865fd4ece31e6c83f7d081beceb419765dcc708310c9c` |

## Not checked

No AI provider or model was run with these prompts, and no test runner or real sign-up form was used. The supported environment remains a plain-text manual exercise.
