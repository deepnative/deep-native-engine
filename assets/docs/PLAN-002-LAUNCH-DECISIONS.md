# PLAN-002: launch decisions and policy review draft

**Issue:** [PLAN-002 #12](https://github.com/deepnative/deep-native-engine/issues/12)

**Prepared:** 23 September 2026

**Accountable decision owner:** Tom Wu
**State:** planning draft; no jurisdictional advice, owner acceptance, public policy, live registration or sales approval

The owner confirmed on 23 September that the operating legal entity, operating province/country and enabled customer countries are **not decided**. This document therefore gives the owner and qualified advisers a concrete review packet without treating a Canadian or Ontario example as the selected legal regime. It cannot satisfy PLAN-002's actual-entity, legal/tax determination and owner-review criteria until those decisions are recorded. The [current product direction](PRODUCT-DIRECTION.md) governs the audience and optional-offer boundaries; [PLAN-001](PLAN-001-SCOPE-RECONCILIATION.md) records the upstream scope decisions. The historical contractor package supplies hypotheses, not accepted terms.

## Decision register and evidence gates

`Open` means no approval or applicability determination exists. A decision becomes `Accepted` only when its named owner records the dated outcome, applicable markets and product versions, adviser evidence where needed, implementation owner, and a recheck trigger. Private contracts, correspondence, tax advice and identity documents belong in restricted storage; GitHub records a non-sensitive evidence reference only. Do not substitute a passing software test for an owner/adviser decision.

| ID | Decision and observable acceptance evidence | Decision owner / specialist | Status and gate |
| --- | --- | --- | --- |
| D01 | Name the selling/contracting legal person, registration identifiers needed for agreements/invoices, operating address and province/country; record a verified source and authorized signer. | Tom Wu / corporate counsel and accountant | **Open.** Blocks real terms, provider accounts, invoices and sales. |
| D02 | Approve the customer-country/province allowlist, member age/eligibility policy, language and support coverage, and how unsupported locations are refused before personal-data collection or checkout. | Tom Wu / jurisdictional counsel | **Open.** Blocks hosted real-member registration, country marketing and live offers. Do not infer Ontario or Canada from the owner's location. |
| D03 | Classify each product separately: foundation learning/participation, digital content, AI-assisted features, individual coaching/review and events. Determine any education/training, consumer-contract or professional-service requirements in each enabled market. | Product owner / consumer and education counsel | **Open.** Blocks public product descriptions and final terms. A professional background is not the optional paid **Professional** offer. |
| D04 | Approve versioned foundation access/pricing/limits and separately approve any optional coaching offer, capacity, dates, taxes and refund path. Show the same version before acceptance and on the retained receipt. | Tom Wu / product, operations, counsel and accountant | **Open; depends on the accepted [CTP-002 #19](https://github.com/deepnative/deep-native-engine/issues/19) offer decision.** Blocks checkout and pricing claims. CAD 3,000/9,000/12,000 remain coaching hypotheses only. |
| D05 | Determine cancellation, renewal, cooling-off and refund rules for each applicable market and offer; record notice method, service-start exceptions, dispute owner and evidence retention. | Counsel / operations / Tom Wu | **Open.** Blocks final agreement and billing logic. A pilot never silently converts. |
| D06 | Determine tax registration, supply classification, place-of-supply, rate source, invoice content and refund/credit-note treatment for each selected market and offer. | Tax adviser / accountant / Tom Wu | **Open.** Blocks live invoices and tax calculation; no universal Canadian rate. |
| D07 | Approve a data inventory, purposes, lawful/consent basis by market, privacy contact, processor locations, vendor terms, safeguards, access/export/deletion paths and breach procedure. | Privacy counsel or qualified privacy lead / security owner | **Open.** Blocks real member uploads and live AI/provider processing. Local synthetic controls do not prove this gate. |
| D08 | Set approved retention schedules by data class, event that starts the clock, legal/financial exceptions, backup/derived-data handling, deletion proof and who can authorize a hold. | Privacy and tax advisers / operations owner | **Open.** Blocks a public deletion promise and production retention configuration. No invented universal duration. |
| D09 | Decide whether marketing messages are sent, by which entity/market, with what recorded permission, identity and opt-out operation. Keep marketing separate from account/service messages. | Marketing owner / counsel | **Open.** Blocks commercial mail campaigns; PLAN-003's limited expert sourcing is a separate operating record. |
| D10 | Approve contribution licence and attribution, third-party material checks, public/group visibility, withdrawal limits, reviewer qualification and appeal. | Product/content owner / IP and privacy counsel | **Open.** Blocks publication of member work; private assignment submission grants no public licence. |
| D11 | Approve community scope, code of conduct, named moderator and backup, report intake, urgent safety escalation, enforcement/appeal and moderation-record retention. | Community operations owner / privacy counsel | **Open.** Blocks real shared spaces, not private foundation learning. |
| D12 | Decide AI/recording providers, regions, data-use and training terms, subprocessors, incident route, costs and insurance needs. Approve separate recording choice and non-recorded alternative. | Tom Wu / security, privacy, insurance adviser | **Open.** Blocks sending member data to a provider, recording or promising insured service. |

Before any decision changes to `Accepted`, the owner records a dated decision note using the [decision template](templates/DECISION.md), the actual adviser/approval identity, a restricted evidence pointer, the markets/offer or policy versions, and the downstream issue(s) to update. A change in entity, market, price, provider, data purpose or effective law reopens the affected decision.

## Draft member-facing language for owner and adviser review

The following is **proposed product copy**, not terms of service or a privacy notice. It describes choices the product needs to make; legal wording, timing and rights remain open under D01–D12. It must not be published as an accepted policy.

| Surface | Proposed plain-language statement or control | Required review before use |
| --- | --- | --- |
| Foundation entry | “Choose a learning goal and start with a suitable exercise. A job title, coding background or coaching purchase is not required.” Show the approved access price/limits if any; do not claim a free tier until D04. | Product owner approves access and eligibility for enabled markets. |
| Optional coaching checkout | Show the named seller, offer/version, full price and taxes, term/start/end dates, included human time and availability, delivery limits, cancellation/refund route and support contact **before** a distinct affirmative purchase action. A standalone pilot needs a later, separate continuation choice; payment instalments do not imply cancel-anytime. | Counsel/tax/operations approve D01–D06 and PLAN-003 confirms actual funded qualified capacity. |
| Account/privacy notice | Explain each collected data class, purpose, recipient/provider, storage region if known, retention/deletion exceptions, contact and request route. Show the current policy version and a way to review it later. | Privacy review of D02, D07 and D08; no claim that all data disappears immediately on account deletion. |
| AI assistance | “This feature may send the material you choose to the named provider for the stated purpose. Check for client or personal information before continuing. AI suggestions are not a qualified human assessment.” Default to no dispatch until the applicable choice and provider gate are satisfied. | Product/privacy/security review of D07/D12, provider configuration and consent withdrawal behavior. |
| Recording | “Choose recording or a written/non-recorded alternative for this event.” Participation in a circle or purchase must not imply recording permission. | All participant rules, storage/retention, notice and withdrawal reviewed under D07/D08/D12. |
| Sharing and contribution | “Your assignment stays private. Choose a separate destination and review the attribution/licence before submitting a resource for publication.” Submission for private feedback or a circle is not public approval. | D10/D11 and content reviewer approval; describe what withdrawal can and cannot undo. |
| Marketing | A separate, optional opt-in for defined messages, with sender identity and an accessible unsubscribe route. Account/service messages use their own justified purpose. | D02/D09 and applicable market review. |

The implementation must record purpose, policy/offer version, affirmative action, time, actor and destination for each applicable choice; refusal and withdrawal must have observable effects. Do not bundle learning, AI processing, recording, contribution publication and marketing into one checkbox. The legal basis and whether a checkbox is necessary are jurisdiction-specific decisions, so this is a product separation requirement rather than a legal conclusion. The product must not imply formal assessment from peer response or AI feedback.

## Retention and deletion review worksheet

The owner must replace every `TBD` with an adviser-reviewed schedule or exception before a live privacy notice or production deletion claim. These are distinct classes because an account delete cannot safely imply deletion of every invoice, audit or backup copy. The existing [private-evidence](CTP-006-PRIVATE-EVIDENCE.md) and [workspace-authorization](CTP-005-WORKSPACE-AUTHORIZATION.md) documents describe local technical behavior only.

| Data class and purpose | Access boundary | Clock/period and exception to decide | Deletion proof to require |
| --- | --- | --- | --- |
| Account, goals and private learning progress | Member; narrowly authorized support | Trigger and duration **TBD**; inactive-account process **TBD** | Primary and derived records, sessions and search/cache copies reconciled. |
| Private assignments, evidence and formal review | Member; assigned unexpired reviewer purpose only | Active/revoked/deleted versions and dispute hold **TBD** | Quarantined object and derived preview/index removal; prior short-lived links expire as documented. |
| Circle posts, reports and contribution drafts | Approved group or moderator scope; private drafts stay private | Departure, report/appeal and publication-retirement rules **TBD** | Group visibility revoked; retained moderation evidence minimized and documented. |
| AI prompts, outputs and provider logs | Member and approved processor purpose | Provider logging/training setting, deletion/backup behavior **TBD** | Processor confirmation and local job/log reconciliation; do not promise provider erasure without evidence. |
| Recording and alternative written summary | Explicit participant and authorized facilitator scope | Consent, withdrawal, storage and deletion period **TBD** | Recordings and derivatives enumerated; written alternative available. |
| Offer acceptance, invoices, payments and tax records | Member and authorized finance operators | Market-specific financial/hold period **TBD** | Retained exception and access restriction explained to requester. |
| Security, access and consent audit; suppression record | Security/privacy/marketing owner | Necessary evidence and minimal duration **TBD** | Preserved only under documented purpose/hold; deletion decision logged. |
| Backups and incident copies | Restricted operations | Rotation, restore and legal-hold process **TBD** | Restored data cannot silently reappear; expiry or re-delete process tested. |

## Community and contribution policy outline

This is a reviewable operating proposal for the bounded circles and reviewed resources in [ECO-04/ECO-05](context/ECOSYSTEM-JOURNEYS.md), not an active public community policy.

1. **Enter deliberately.** Show the circle's topic, intended audience, visibility, rules and responsible moderator before opt-in. A member's background, goal or paid status does not grant moderation or staff access. Leaving revokes future access; it does not silently publish or erase private work.
2. **Keep examples safe.** Ask members to use material they may share, remove client/person identifiers and respect others. No harassment, hate, impersonation, doxxing, confidential client material or unsolicited promotion. Give a route for accessibility needs and an alternative to public posting.
3. **Report and triage.** Provide an in-product report path and a named monitored contact. Restrict report contents to trained moderators; acknowledge receipt without promising a fixed SLA until staffed. Triage urgent safety/privacy allegations to the incident owner, preserve only necessary evidence, and avoid exposing the reporter to the reported person.
4. **Act with review.** A moderator records reason, scoped action (hide, restrict, remove, restore), affected content version, time and appeal route. A different authorized person reviews appeals where feasible; conflicts of interest escalate. Do not let a general operator open unrelated private assignments.
5. **Publish contributions separately.** The contributor states authorship/third-party permissions and selects destination. An editor checks sources, attribution and rights; a qualified reviewer approves educational/technical claims within their domain. The record pins content, licence, attribution, consent and review versions. Rejection or retirement leaves private evidence private.
6. **Explain withdrawal honestly.** A member can revoke future group/public visibility through the approved process. Previously downloaded or independently copied material may not be retractable; counsel must approve precise wording and any irrevocable licence scope. The product must not promise universal recall.

Proposed rights default: the member keeps their contribution rights; an opt-in grant, if approved, names the operator, permitted destinations, use, adaptation, duration, attribution and withdrawal effects. CIPO distinguishes a licence (permission while the creator retains ownership) from an assignment (transfer of rights); the actual agreement and market applicability need IP review. Third-party client or copyrighted material requires a documented permission path or rejection, never an assumption from an upload. [CIPO ownership-transfer guidance](https://ised-isde.canada.ca/site/canadian-intellectual-property-office/en/copyright/transfer-ownership) supports the distinction, not this product's legal terms.

## Conditional official-source review, 23 September 2026

These primary sources identify questions for advisers. They do not establish that a particular law applies to the undecided entity or markets. Recheck current law on the decision date.

| Topic | Official source and what it prompts us to verify |
| --- | --- |
| Canadian private-sector privacy, **if applicable** | [Office of the Privacy Commissioner of Canada: PIPEDA requirements in brief](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda_brief/) describes accountability, purposes, consent, collection/use/retention limits, safeguards and access. Determine entity, activity and cross-border applicability first. |
| Processor choice, **if applicable** | [OPC: assessing third-party service providers](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/gd_third-party_202609/) prompts diligence about provider practices and organizational accountability. Record regions, subprocessors, contractual limits and incident/deletion evidence before live AI or storage. |
| Canadian commercial electronic messages, **if applicable** | [CRTC CASL guidance](https://crtc.gc.ca/eng/com500/faq500.htm) discusses consent, sender identification and unsubscribe. Determine message/recipient applicability and record permission evidence rather than treating account creation as marketing consent. |
| Canadian GST/HST, **if applicable** | [CRA e-commerce guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-specific-situations/e-commerce.html) distinguishes digital rights and human services and asks for place-of-supply analysis. A tax adviser must classify each actual offer and market. |
| Ontario consumer law, **only if Ontario is selected or otherwise relevant** | [Ontario's Consumer Protection Act, 2002](https://www.ontario.ca/laws/statute/02c30) and the [2023 Act](https://www.ontario.ca/laws/statute/23c23) need an effective-date check: the 2023 Act's official page states it is not yet in force as checked here. Counsel must verify the operative statute, regulations, contract type and current cancellation/refund rules at launch. |
| Canadian copyright, **if applicable** | [CIPO licence/assignment guidance](https://ised-isde.canada.ca/site/canadian-intellectual-property-office/en/copyright/transfer-ownership) frames the ownership-versus-permission decision for member contributions; obtain actual contributor and third-party rights review. |

Other enabled countries require their own primary-source and adviser review. This document does not imply that Canadian rules are sufficient for international members, minors, recorded sessions, professional accreditation or regulated advice.

## Launch decision checklist and handoff

| Gate | Owner must inspect and record | Current state |
| --- | --- | --- |
| Real-member registration | D01/D02/D07/D08, approved privacy contact, eligibility/location handling, terms and versioned consent screens; test export/deletion and incident contact with real operating roles | **Blocked:** entity/markets and qualified review unknown. Synthetic local preview only. |
| Community participation | D07/D08/D10/D11, staffed moderator/backup, report/appeal route, rights and privacy review; test private-to-group boundary and departure | **Blocked:** policy and operations unapproved. |
| Live AI, external storage or recording | D07/D08/D12, signed provider terms, data-flow/security/retention review, explicit feature choice, spend/failure owner; test no-consent and revocation | **Blocked:** provider and approvals unknown. Deterministic local adapters are not provider evidence. |
| Paid offer/checkout | D01–D06, actual expert capacity from [PLAN-003](PLAN-003-CAPACITY-OPERATIONS.md), approved offer version, tax/invoice settings, refund operator and reconciled test payments; test pilot/continuation/renewal dates | **Blocked:** entity/markets, terms, tax and qualified capacity unknown. No live charges. |
| Publication/release decision | D01–D12 as applicable, owner go/no-go record, current legal/tax source check, policy/version archive, owner-reviewed release evidence under CTP-025 | **Blocked:** no launch approval. Passing `make verify` covers the local slice only. |

**Acceptance state for #12:** This draft covers a decision register, proposed language, separate consent boundaries, a retention worksheet, contribution/community operating questions and evidence locations. The issue remains open because actual entity/market selection, applicable-law review, qualified adviser determinations, approved terms/policies and owner go/no-go are absent. PLAN-003 capacity and CTP-002 offer decisions are additional paid-path dependencies. Do not mark the issue Done, publish these drafts to members or enable live effects from this artifact.
