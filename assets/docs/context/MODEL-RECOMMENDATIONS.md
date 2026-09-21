# Recommended models for roadmap issues

## Recommended model labels

- `model:gpt-6-astra` / `model:gpt-5.6-sol`: the recommended primary model for the whole issue. Every issue has exactly one.
- `reasoning:high`: default reasoning effort. `escalate:xhigh` marks work where difficult design, concurrency, security or cross-module failures may justify XHigh.
- `review:gpt-6-astra`: an independent Astra High review using the acceptance criteria, diff and evidence. An Astra-led issue should still receive a separate review when marked.
- `design:gpt-6-astra`: Astra High defines/reviews the test strategy; Sol High implements it. Applies to QA-001–003 and CTP-023.

Astra leads epics, architecture, threat modeling, authorization/privacy, financial state, concurrency, AI gateway controls and release readiness. Sol leads routine features, browser/a11y work, business planning and future discovery. Terra/Luna are reserved for future small, precisely scoped subtasks; no current whole issue is assigned to them. These are project recommendations, not repository benchmark results.

Labels do not select a running model, assign an agent, authorize implementation, or change any coverage/review/launch gate. Business and specialist decisions retain their named human accountability.

| Issue | Primary model | Reasoning | Design | Review | XHigh escalation |
|---|---|---|---|---|---|
| [ROADMAP #1](https://github.com/deepnative/deep-native-engine/issues/1) | gpt-6-astra | high | — | — | — |
| [GATE-A #2](https://github.com/deepnative/deep-native-engine/issues/2) | gpt-6-astra | high | — | — | — |
| [GATE-B #3](https://github.com/deepnative/deep-native-engine/issues/3) | gpt-6-astra | high | — | — | — |
| [GATE-C #4](https://github.com/deepnative/deep-native-engine/issues/4) | gpt-6-astra | high | — | — | — |
| [GATE-D #5](https://github.com/deepnative/deep-native-engine/issues/5) | gpt-6-astra | high | — | — | — |
| [GATE-E #6](https://github.com/deepnative/deep-native-engine/issues/6) | gpt-6-astra | high | — | — | — |
| [GATE-F #7](https://github.com/deepnative/deep-native-engine/issues/7) | gpt-6-astra | high | — | — | — |
| [PLAN-001 #8](https://github.com/deepnative/deep-native-engine/issues/8) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [GOV-001 #11](https://github.com/deepnative/deep-native-engine/issues/11) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [PLAN-002 #12](https://github.com/deepnative/deep-native-engine/issues/12) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [PLAN-003 #13](https://github.com/deepnative/deep-native-engine/issues/13) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [PLAN-004 #14](https://github.com/deepnative/deep-native-engine/issues/14) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [QA-001 #16](https://github.com/deepnative/deep-native-engine/issues/16) | gpt-5.6-sol | high | gpt-6-astra | gpt-6-astra | — |
| [QA-002 #17](https://github.com/deepnative/deep-native-engine/issues/17) | gpt-5.6-sol | high | gpt-6-astra | gpt-6-astra | — |
| [QA-003 #22](https://github.com/deepnative/deep-native-engine/issues/22) | gpt-5.6-sol | high | gpt-6-astra | gpt-6-astra | — |
| [QA-004 #18](https://github.com/deepnative/deep-native-engine/issues/18) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [QA-005 #43](https://github.com/deepnative/deep-native-engine/issues/43) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-001 #15](https://github.com/deepnative/deep-native-engine/issues/15) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-002 #19](https://github.com/deepnative/deep-native-engine/issues/19) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-003 #20](https://github.com/deepnative/deep-native-engine/issues/20) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-004 #23](https://github.com/deepnative/deep-native-engine/issues/23) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-005 #24](https://github.com/deepnative/deep-native-engine/issues/24) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-006 #25](https://github.com/deepnative/deep-native-engine/issues/25) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-007 #26](https://github.com/deepnative/deep-native-engine/issues/26) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-008 #28](https://github.com/deepnative/deep-native-engine/issues/28) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-009 #33](https://github.com/deepnative/deep-native-engine/issues/33) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-010 #38](https://github.com/deepnative/deep-native-engine/issues/38) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-011 #27](https://github.com/deepnative/deep-native-engine/issues/27) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-012 #29](https://github.com/deepnative/deep-native-engine/issues/29) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-013 #30](https://github.com/deepnative/deep-native-engine/issues/30) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-014 #31](https://github.com/deepnative/deep-native-engine/issues/31) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-015 #34](https://github.com/deepnative/deep-native-engine/issues/34) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-016 #32](https://github.com/deepnative/deep-native-engine/issues/32) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-017 #35](https://github.com/deepnative/deep-native-engine/issues/35) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-018 #36](https://github.com/deepnative/deep-native-engine/issues/36) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-019 #39](https://github.com/deepnative/deep-native-engine/issues/39) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-020 #37](https://github.com/deepnative/deep-native-engine/issues/37) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-021 #40](https://github.com/deepnative/deep-native-engine/issues/40) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [CTP-022 #41](https://github.com/deepnative/deep-native-engine/issues/41) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42) | gpt-5.6-sol | high | gpt-6-astra | gpt-6-astra | When needed |
| [CTP-024 #44](https://github.com/deepnative/deep-native-engine/issues/44) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [CTP-025 #45](https://github.com/deepnative/deep-native-engine/issues/45) | gpt-6-astra | high | — | gpt-6-astra | When needed |
| [OPS-001 #21](https://github.com/deepnative/deep-native-engine/issues/21) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [OPS-002 #46](https://github.com/deepnative/deep-native-engine/issues/46) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [OPS-003 #47](https://github.com/deepnative/deep-native-engine/issues/47) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [OPS-004 #48](https://github.com/deepnative/deep-native-engine/issues/48) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [OPS-005 #49](https://github.com/deepnative/deep-native-engine/issues/49) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-001 #50](https://github.com/deepnative/deep-native-engine/issues/50) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-002 #55](https://github.com/deepnative/deep-native-engine/issues/55) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-003 #9](https://github.com/deepnative/deep-native-engine/issues/9) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-004 #10](https://github.com/deepnative/deep-native-engine/issues/10) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-005 #51](https://github.com/deepnative/deep-native-engine/issues/51) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-006 #52](https://github.com/deepnative/deep-native-engine/issues/52) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-007 #53](https://github.com/deepnative/deep-native-engine/issues/53) | gpt-5.6-sol | high | — | gpt-6-astra | — |
| [EXP-008 #54](https://github.com/deepnative/deep-native-engine/issues/54) | gpt-5.6-sol | high | — | gpt-6-astra | — |
