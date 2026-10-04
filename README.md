# Deep Native Engine

Deep Native Engine helps curious learners, IT practitioners and professionals in other fields learn to use AI in practical ways. You can start without coding or a career plan: choose a direction, try a small exercise and decide what to learn next.

[Explore the product introduction](https://deepnative.github.io/deep-native-engine/) for the current experience, who it serves and how to get started.

## What you can do in the current preview

- **Find a starting point.** Choose whether you want to explore AI, use it at work or build something. Your goal and background shape a simple learning path that you can change later.
- **Learn by doing.** Work through a short lesson on giving AI a clear instruction, then practise with invented examples. Browse sample lessons and compare your own response with the source material. Opt into a private sample practice conversation, revisit up to 15 response/comparison pairs, export your history or withdraw its text. Comparisons are deterministic prompts, not AI or qualified assessment.
- **Keep track of your work.** Save an exercise draft, mark it complete through self-assessment, and revisit your private learning activity. Switching goals keeps your earlier practice attached to its original direction. You can also plan milestones and keep sample assignments or evidence.
- **Exchange private sample feedback.** An explicitly authorized local reviewer can draft source-quoted comments and publish them to the sample owner. Ask one clarification and receive one answer, retain earlier feedback when revising, or withdraw access and delete the sample. This is human-authored sample feedback, not formal assessment or a paid review; see [the feedback guide](assets/docs/PRIVATE-SAMPLE-FEEDBACK.md).
- **Try private sample support.** Submit an invented request, follow its receipt and read explicitly shared local operator replies. Allocate existing support test minutes, cancel an unstarted hold, and see used and returned minutes after a separately granted local operator records bounded effort. A separately authorized local operator can see the request’s observed age and one exact test-effort receipt together; reading starts no work and grants no extra access. Withdraw request text or export your retained records. Coverage is unverified and no response deadline is promised; see [operator setup](assets/docs/PRIVATE-SAMPLE-SUPPORT.md) and [test-minute guide](assets/docs/PRIVATE-SUPPORT-TEST-MINUTES.md).
- **Explore sample appointment windows.** With explicitly seeded test minutes, reserve a short sample hold, withdraw it and reload your own receipt. Expired sessions cannot retrieve private receipts or allowances, including during a delayed check. These are examples, not real bookings; see [the sample-hold guide](assets/docs/CTP-012-MEMBER-SAMPLE-HOLDS.md).
- **See your local test units.** Inspect your own configured test minutes, sessions and requests, then download a current summary or your retained grant, hold, event and settlement history. Held and expired units stay distinct; history counters are separate from current usable balances. Reading creates no allowance, booking or purchase; see [the private preview guide](assets/docs/PRIVATE-MEMBER-TEST-UNITS.md).
- **Run a local request with test units.** Choose one invented text sample and explicitly hold an existing study request. Completion consumes it once; cancellation before it starts releases it subject to expiry. Uncertain outcomes remain held. See [the local request guide](assets/docs/PRIVATE-LOCAL-AI-TEST-REQUESTS.md).
- **Inspect local synthetic accounting.** Operators can view observed unit balances and structural discrepancies without exposing member details. This does not verify payments or qualified service capacity; see [the report guide](assets/docs/PRIVATE-SYNTHETIC-LEDGER-RECONCILIATION.md).
- **Try invented circle discussion.** In an explicitly enabled local sandbox, separately choose sharing, exchange invented questions and replies, save private sample reports and observe scoped synthetic hide/restore actions. Withdraw your text, leave and export or erase your own records. See [the circle discussion guide](assets/docs/LOCAL-CIRCLE-DISCUSSION.md) for setup and limits.
- **Explore ways to participate.** Try local previews of learning circles and events. Draft a private contribution, revise it using explicit moderator feedback, and confirm rights again before resubmitting. Optional career planning stays private and unsent.

This is a **local learning preview**, not a launched service. Lessons and participation examples are synthetic. There is no live AI provider, public community, staffed moderation, qualified assessment, real booking or payment flow. Use invented or sample information only. See the [product direction](assets/docs/PRODUCT-DIRECTION.md) for the wider vision and the [project board](https://github.com/orgs/deepnative/projects/1/views/1) for work still in progress.

## Run the local learning preview

Your preview work is stored in local PostgreSQL and accessed through your browser session. Use it on your own computer with sample data.

Prerequisites: Node 24 (`.nvmrc`), Git, Make, Python 3.11+, Docker/Compose with a running daemon.

```sh
make setup
make verify
make dev
```

Open `http://127.0.0.1:3000`. Setup installs locked dependencies, Chromium, Firefox and WebKit for browser checks, the local database and the pre-push hook. It preserves an existing `.env`. See [verification and troubleshooting](assets/docs/workflows/VERIFICATION.md).

The [quality gates](assets/docs/context/QUALITY-GATES.md) and [scope and acceptance](assets/docs/INITIAL-LEARNING-SLICE.md) explain what is tested in this preview and what remains for the full MVP.

## Team setup

Read [AGENTS.md](AGENTS.md) and the [team workflow](assets/docs/workflows/TEAM-WORKFLOW.md) before taking an issue. Codex discovers the repo-local skills and custom agents when this repository is opened as a trusted project; reload the project after adding them if needed. Use the same written workflow in other assistants.

| Task                         | Skill                | Suggested role                          |
| ---------------------------- | -------------------- | --------------------------------------- |
| Clarify scope and acceptance | `$dne-plan-issue`    | `dne-planner`                           |
| Deliver an authorized slice  | `$dne-deliver-issue` | `dne-builder` or `dne-critical-builder` |
| Review changes and evidence  | `$dne-review-change` | `dne-reviewer`                          |
| Validate and hand off work   | `$dne-handoff`       | `dne-verifier`                          |

The [documentation index](assets/docs/README.md) includes the original context, model recommendations, templates, and workflow. Shared instructions make the process reproducible; model outputs still require review and tests. Delivery includes merging accepted changes to `main` and verifying the resulting CI.
