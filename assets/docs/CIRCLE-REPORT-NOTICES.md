# Private circle report decision notices

From **Local circles → Questions → Your sample reports**, open your own durable receipt and choose **Inspect the latest decision available for this report**. Before a later moderation action, the notice says no later recorded decision is currently available. After a currently eligible target is hidden or restored, it shows the latest recorded action, structured reason, old and new revisions, and decision time. The report category and report time are separate from the decision reason and time.

A notice describes the latest target decision at or after your report was created. It does not say your report caused the action, resolve your individual report, or display the whole decision history. The contribution owner's [notice](CIRCLE-MODERATION-NOTICES.md) and [reconsideration path](CIRCLE-MODERATION-APPEALS.md) are separate. Ordinary report disposition and escalation remain outside this notice delivery.

Decision details require current deliberate discussion sharing by you and the source authors in this exact circle, eligible source and question, and current account authority. Leaving, withdrawing sharing or source text, an unavailable question, account erasure, or pausing discussion removes these details. A later join or sharing choice does not republish old source. Your own content-free report receipt remains private until your account is deleted; source-owner erasure removes decision availability without erasing your independent receipt.

**Download this report decision snapshot** saves one bounded JSON object with `reportNoticeVersion: 1`, circle and own report references, original category/time, current target availability, and either no available decision or its action, reason, old/new revisions and time. It excludes source text, target/root references, member or staff identities, private learning work and internal keys. It is separate from the general activity export. It reuses existing report and immutable moderation records and creates no new retained row or cross-owner snapshot. Account deletion cannot remove a copy you saved on your device.

Only the current reporter can open or download this notice. Another member, the contribution owner and staff do not gain access to it. Malformed or extra query fields are rejected. A database or connection uncertainty returns an unavailable response without an attachment; explicitly inspect again rather than assuming a response was confirmed. There is no automatic retry or new moderation action.

This local preview uses invented information and finite test-purpose moderator grants. Notices promise no staffed response, independent or qualified review, moderation contact, response time or service level. They establish no hosted or full-MVP acceptance.

## Acceptance and evidence mapping

| Contract | Observable outcome | Planned executable evidence |
| --- | --- | --- |
| RPTN-01 | Own report links to truthful no-later-decision/latest hide or restoration notice | Store and route units, native PostgreSQL/HTTP, L251–253 browser journeys |
| RPTN-02 | Current reporter only; foreign, staff, malformed and lifetime denial without attachment | Unit projection/routes and native authority cases |
| RPTN-03 | Reporter/source/root eligibility loss or pause removes decision availability | Native leave/choice/text/root/erasure, unit pause, browser withdrawal/leave |
| RPTN-04 | Ordered authority/source locks and one committed snapshot | Native observed workspace-lock wait and concurrent restoration, unit final-authority loss |
| RPTN-05 | Explicit bounded serialization, no new rows, sanitized uncertain handback | Unit whitelist/faults, native count checks and actual lost COMMIT/release handback |
| RPTN-06 | Independent receipt ownership and account cascade; three backgrounds | Native source/reporter erasure and L251–253 desktop/mobile |

Scenario prose is not test proof. Delivery evidence must name the actual checked revision, original reports, full local and hook gates, PR and resulting-main CI, dedicated main demonstration and safe cleanup. All previous approved journeys and the separate outstanding full-MVP register remain intact.
