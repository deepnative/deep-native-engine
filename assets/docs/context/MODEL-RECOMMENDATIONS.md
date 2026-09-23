# Recommended models for roadmap issues

**Reviewed:** 23 September 2026 against all 55 live GitHub issue scopes and the newly released GPT-6 Sol/Luna family.

## Routing rule

- `model:gpt-6-astra` leads cross-domain architecture, authorization/privacy, money/ledger, concurrency, threat modeling and release or stage decisions.
- `model:gpt-6-sol` leads bounded delivery, QA implementation, content, discovery and operational planning with independent Astra review where marked.
- `reasoning:medium`, `reasoning:high` and `reasoning:xhigh` are mutually exclusive recommended starting efforts. Medium covers contained work; High is the usual choice for multi-step issue delivery; XHigh is reserved for the ten highest-risk cross-boundary issues. An `escalate:xhigh` label flags a High issue whose difficulty may warrant changing its actual task setting.
- `review:gpt-6-astra` requests an independent Astra High review of the acceptance criteria, diff and evidence. An Astra-led issue still requires a separate reviewer when marked.
- `design:gpt-6-astra` asks Astra High to design or review the test strategy before the primary model implements it.
- GPT-6 Luna is suitable for small, precisely bounded subtasks such as extraction, triage or narrow edits. None of these 55 whole issues is narrow enough to route to Luna as lead; split and review a subtask when it is useful.

The recommendations are based on issue scope and [official OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and the [22 September release note](https://developers.openai.com/api/docs/changelog). They are not measured repository benchmarks or a claim about account-specific availability. Confirm the model in the actual task before work; labels do not launch agents, grant authorization or change any quality/launch gate. Human owners retain legal, product, commercial and release decisions.

Closed issues retain their completion evidence. Updated labels on them express the recommendation for a comparable future issue; they do not rewrite which model performed historical work.

| Issue | Lead | Effort | Design | Review | Escalation | Routing reason |
| --- | --- | --- | --- | --- | --- | --- |
| [ROADMAP #1](https://github.com/deepnative/deep-native-engine/issues/1) | gpt-6-astra | high | — | — | — | Cross-phase scope, dependencies and evidence gates |
| [GATE-A #2](https://github.com/deepnative/deep-native-engine/issues/2) | gpt-6-astra | high | — | — | — | Phase A decision across product, content and capacity |
| [GATE-B #3](https://github.com/deepnative/deep-native-engine/issues/3) | gpt-6-astra | high | — | — | — | Full private MVP acceptance and release gate |
| [GATE-C #4](https://github.com/deepnative/deep-native-engine/issues/4) | gpt-6-astra | high | — | — | — | Paid-pilot decision with real service evidence |
| [GATE-D #5](https://github.com/deepnative/deep-native-engine/issues/5) | gpt-6-astra | high | — | — | — | Continuation decision with money and usage evidence |
| [GATE-E #6](https://github.com/deepnative/deep-native-engine/issues/6) | gpt-6-astra | high | — | — | — | Repeatability decision across delivery and economics |
| [GATE-F #7](https://github.com/deepnative/deep-native-engine/issues/7) | gpt-6-astra | high | — | — | — | Expansion gate across distinct product and legal risks |
| [PLAN-001 #8](https://github.com/deepnative/deep-native-engine/issues/8) | gpt-6-sol | high | — | gpt-6-astra | — | Cross-audience story map and source reconciliation |
| [GOV-001 #11](https://github.com/deepnative/deep-native-engine/issues/11) | gpt-6-sol | high | — | gpt-6-astra | — | Repository governance and evidence controls |
| [PLAN-002 #12](https://github.com/deepnative/deep-native-engine/issues/12) | gpt-6-astra | high | — | gpt-6-astra | — | Jurisdiction, consent, terms and launch decision boundaries |
| [PLAN-003 #13](https://github.com/deepnative/deep-native-engine/issues/13) | gpt-6-sol | high | — | gpt-6-astra | — | Qualified staffing, cost and capacity planning |
| [PLAN-004 #14](https://github.com/deepnative/deep-native-engine/issues/14) | gpt-6-sol | high | — | gpt-6-astra | — | Accessible curriculum, rights and review calibration |
| [QA-001 #16](https://github.com/deepnative/deep-native-engine/issues/16) | gpt-6-sol | high | gpt-6-astra | gpt-6-astra | — | Executable coverage gate with independent test design |
| [QA-002 #17](https://github.com/deepnative/deep-native-engine/issues/17) | gpt-6-sol | high | gpt-6-astra | gpt-6-astra | — | Full journey denominator and browser gate design |
| [QA-003 #22](https://github.com/deepnative/deep-native-engine/issues/22) | gpt-6-sol | high | gpt-6-astra | gpt-6-astra | — | Push and CI quality enforcement with test design |
| [QA-004 #18](https://github.com/deepnative/deep-native-engine/issues/18) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Threat model spanning private data, payments and AI |
| [QA-005 #43](https://github.com/deepnative/deep-native-engine/issues/43) | gpt-6-sol | high | — | gpt-6-astra | — | Browser, accessibility and performance verification |
| [CTP-001 #15](https://github.com/deepnative/deep-native-engine/issues/15) | gpt-6-astra | high | — | gpt-6-astra | XHigh if needed | Architecture and domain boundary decisions |
| [CTP-002 #19](https://github.com/deepnative/deep-native-engine/issues/19) | gpt-6-astra | high | — | gpt-6-astra | XHigh if needed | Access, coaching offers, entitlements and pricing invariants |
| [CTP-003 #20](https://github.com/deepnative/deep-native-engine/issues/20) | gpt-6-sol | high | — | gpt-6-astra | — | Cross-audience profile, readiness and expert registry |
| [CTP-004 #23](https://github.com/deepnative/deep-native-engine/issues/23) | gpt-6-sol | high | — | gpt-6-astra | — | Deterministic adapters, configuration and durable jobs |
| [CTP-005 #24](https://github.com/deepnative/deep-native-engine/issues/24) | gpt-6-astra | high | — | gpt-6-astra | XHigh if needed | Identity, staff grants, revocation and audit |
| [CTP-006 #25](https://github.com/deepnative/deep-native-engine/issues/25) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Private evidence, quarantine and deletion races |
| [CTP-007 #26](https://github.com/deepnative/deep-native-engine/issues/26) | gpt-6-sol | high | — | gpt-6-astra | — | Versioned catalog and safe publication workflow |
| [CTP-008 #28](https://github.com/deepnative/deep-native-engine/issues/28) | gpt-6-sol | high | — | gpt-6-astra | — | Goal-based onboarding with optional paid acceptance |
| [CTP-009 #33](https://github.com/deepnative/deep-native-engine/issues/33) | gpt-6-sol | medium | — | gpt-6-astra | — | Accessible lesson, progress and assignment behavior |
| [CTP-010 #38](https://github.com/deepnative/deep-native-engine/issues/38) | gpt-6-astra | high | — | gpt-6-astra | — | Qualified review publication and evidence authorization |
| [CTP-011 #27](https://github.com/deepnative/deep-native-engine/issues/27) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Immutable ledger and concurrent entitlement reservations |
| [CTP-012 #29](https://github.com/deepnative/deep-native-engine/issues/29) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Concurrent booking, time zones and credit exceptions |
| [CTP-013 #30](https://github.com/deepnative/deep-native-engine/issues/30) | gpt-6-sol | medium | — | gpt-6-astra | — | Bounded published workflow catalog and safe downloads |
| [CTP-014 #31](https://github.com/deepnative/deep-native-engine/issues/31) | gpt-6-astra | xhigh | — | gpt-6-astra | — | AI consent, budget, queue and ambiguous retry controls |
| [CTP-015 #34](https://github.com/deepnative/deep-native-engine/issues/34) | gpt-6-sol | high | — | gpt-6-astra | — | Grounded AI study feedback and allowance controls |
| [CTP-016 #32](https://github.com/deepnative/deep-native-engine/issues/32) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Payment event order, idempotency and refunds |
| [CTP-017 #35](https://github.com/deepnative/deep-native-engine/issues/35) | gpt-6-astra | high | — | gpt-6-astra | XHigh if needed | Renewal, cancellation, invoice and anniversary rules |
| [CTP-018 #36](https://github.com/deepnative/deep-native-engine/issues/36) | gpt-6-sol | medium | — | gpt-6-astra | — | Member-owned goals, milestones and private drafts |
| [CTP-019 #39](https://github.com/deepnative/deep-native-engine/issues/39) | gpt-6-astra | high | — | gpt-6-astra | — | Staff scopes, moderation and time reconciliation |
| [CTP-020 #37](https://github.com/deepnative/deep-native-engine/issues/37) | gpt-6-astra | high | — | gpt-6-astra | — | Concurrent event seats, consent and service capacity |
| [CTP-021 #40](https://github.com/deepnative/deep-native-engine/issues/40) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Cohort privacy, contribution rights, export and deletion |
| [CTP-022 #41](https://github.com/deepnative/deep-native-engine/issues/41) | gpt-6-sol | high | — | gpt-6-astra | — | Reconciled learning and service metrics with privacy |
| [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42) | gpt-6-astra | xhigh | gpt-6-astra | gpt-6-astra | — | Cross-domain state, privacy and AI reliability proof |
| [CTP-024 #44](https://github.com/deepnative/deep-native-engine/issues/44) | gpt-6-astra | high | — | gpt-6-astra | — | Full-MVP release rehearsal and acceptance evidence |
| [CTP-025 #45](https://github.com/deepnative/deep-native-engine/issues/45) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Production restore, privacy, billing and launch controls |
| [OPS-001 #21](https://github.com/deepnative/deep-native-engine/issues/21) | gpt-6-sol | medium | — | gpt-6-astra | — | Bounded acquisition plan with truthful consent evidence |
| [OPS-002 #46](https://github.com/deepnative/deep-native-engine/issues/46) | gpt-6-astra | high | — | gpt-6-astra | — | Real paid-pilot delivery and cost evidence |
| [OPS-003 #47](https://github.com/deepnative/deep-native-engine/issues/47) | gpt-6-astra | high | — | gpt-6-astra | — | Paid continuation and actual recurring-use evidence |
| [OPS-004 #48](https://github.com/deepnative/deep-native-engine/issues/48) | gpt-6-astra | high | — | gpt-6-astra | — | Repeatable demand, funded capacity and service economics |
| [OPS-005 #49](https://github.com/deepnative/deep-native-engine/issues/49) | gpt-6-sol | high | — | gpt-6-astra | — | Specialist offer buyer, staffing and cost analysis |
| [EXP-001 #50](https://github.com/deepnative/deep-native-engine/issues/50) | gpt-6-sol | high | — | gpt-6-astra | — | Practice offer buyer test and service costing |
| [EXP-002 #55](https://github.com/deepnative/deep-native-engine/issues/55) | gpt-6-sol | high | — | gpt-6-astra | — | Partner service scope, staffing and costed decision |
| [EXP-003 #9](https://github.com/deepnative/deep-native-engine/issues/9) | gpt-6-sol | high | — | gpt-6-astra | — | Voice/video discovery with consent and accessibility |
| [EXP-004 #10](https://github.com/deepnative/deep-native-engine/issues/10) | gpt-6-sol | high | — | gpt-6-astra | — | Provider integration discovery and contract design |
| [EXP-005 #51](https://github.com/deepnative/deep-native-engine/issues/51) | gpt-6-astra | xhigh | — | gpt-6-astra | — | Hosted agent sandbox, secrets and prompt-injection threat model |
| [EXP-006 #52](https://github.com/deepnative/deep-native-engine/issues/52) | gpt-6-astra | high | — | gpt-6-astra | — | Client-system permissions, revocation and rollback |
| [EXP-007 #53](https://github.com/deepnative/deep-native-engine/issues/53) | gpt-6-sol | high | — | gpt-6-astra | — | Country, language, tax and content readiness analysis |
| [EXP-008 #54](https://github.com/deepnative/deep-native-engine/issues/54) | gpt-6-astra | high | — | gpt-6-astra | — | Organization tenancy, marketplace and pricing tradeoffs |
