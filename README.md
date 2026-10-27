# Deep Native Engine

Members with a verified email can sign out through **My account** and deliberately return by email to the same saved learning. Sign-out invalidates the current bearer, including copied cookies; browser-only accounts must verify email first. An uncertain result offers account inspection and email return without automatically repeating the action.

Deep Native Engine helps curious learners, IT practitioners and professionals in other fields learn to use AI in practical ways. You can start without coding or a career plan: choose a direction, try a small exercise and decide what to learn next.

[Try the GitHub Pages sample](https://deepnative.io/deep-native-engine/#sample-demo): choose a direction, practise with an invented brief, deliberately save a draft, self-check, and reload progress in the same browser tab. These simulated actions never change an account or call an AI provider. [Open the existing user portal](https://engine.deepnative.io/learn) for the separate Azure application and its saved sample work. See the [sample walkthrough and limits](assets/docs/PAGES-SAMPLE-DEMO.md).

## What you can do

- **Start with no-charge foundation access.** Learn and save progress without a coaching plan or payment. [Access details](https://engine.deepnative.io/readiness/offers) show the current initial policy; this is not a promise of a permanent price or term. Optional coaching remains unavailable, and common membership grants no paid-service credits, live AI allowance or staff privileges.
- **See and manage your account.** Ordinary onboarding accepts your own background, goals and preferences without a global sample-data pledge. **Signed in · My account** is visible above your learning plan; open it to inspect and edit the same private profile and check linked-email, browser-only or unavailable recovery status. Separately labelled exercises and rehearsals retain their sample-data requirements.
- **Learn and track.** Choose a goal, follow a private starter plan, read sample lessons and retain self-assessed progress. Change direction while keeping earlier goal history. Return to recorded lessons without silently switching to replacement versions. Keyboard error links let you correct exercise fields while keeping your entries.
- **Keep access to saved learning when email delivery is configured.** A returning visitor sees **Sign in** when email delivery is configured. An existing member can open **My account → Link an email** (or **Email access** on the learning page), verify a private 15-minute link, then request a one-use sign-in link from another browser. Repeated requests preserve the pending 15-minute link and send no duplicate message. Sign-in reopens the same member and saved work, and replaces the earlier browser token. Already linked members see their own linked status and guidance to use email sign-in in another browser; a stale attachment form sends no new message. Cookie-only records remain intact until their member opts in. The hosted portal shows these controls only while an authorized sender is configured; actual delivery still requires a hosted receipt test.
- **Practise with AI examples.** Try private prompts, sample exercises and locally simulated study conversations. These use deterministic examples rather than a live model provider.
- **Submit and receive feedback.** When assignment handoff is enabled, select an exact submitted assignment version and explicitly create a private feedback copy. Your newer draft stays separate. Request review separately. With staff entry and assignment administration enabled, a current administrator discovers pending exact references without seeing your source text, then explicitly assigns a reviewer for a finite window. The assigned reviewer can publish feedback and answer one clarification. Withdrawing access stops new reviewer reads and exchanges while feedback stays visible to you. Deleting only a copy keeps your original attempt; deleting the original removes its linked copies and feedback. Provided invented samples remain available in their separate rehearsal. Feedback identifies the reviewer account without claiming verified human authorship or formal assessment.
- **Participate and contribute.** Join or leave local circles, try deliberately enabled invented discussion, or draft and revise a private contribution. Joining never publishes your private learning work. With ordinary contributions deliberately enabled, submit privately for exact-revision editorial acceptance, then separately choose attribution and member-only display permission. Withdraw sharing while retaining the private original; quarantine and deletion stop future reads. See the [contribution sharing guide](assets/docs/CTP-007-MEMBER-PUBLICATION.md).
- **Explore workflow drafts.** Search invented manual examples, copy their text or download the displayed draft version. If that version is unavailable, choose the current draft explicitly. These Markdown files do not execute or connect to a provider.
- **Control your private work.** Inspect and download your own retained activity, withdraw sharing and delete local preview records through the existing controls.

Optional local rehearsals also cover study/support test units, sample support requests and invented event registration. The [product guides](assets/docs/README.md) explain their separate setup and limits; they are not universal paid membership features.

The hosted member site retains private learning work; local rehearsals use invented information. Assignment feedback accepts a member’s own text only when its separate handoff setting is enabled. There is no live AI provider, public community, staffed moderation, qualified assessment, real booking or payment flow. Ordinary foundation material awaiting editorial review stays in draft. See the [product direction](assets/docs/PRODUCT-DIRECTION.md) and [project board](https://github.com/orgs/deepnative/projects/1/views/1) for the wider scope.

## Rehearse the core paths together

After `make setup`, run `make preview` and open its printed local address. In one fresh private runtime, learn and track a labelled invented lesson, choose an invented practice assignment and save/reload its private response, deliberately request and receive finite study test units from the selected administrator for a local simulated request, submit a provided sample and receive feedback through separate member/admin/reviewer browsers, send a private support request that an administrator assigns to a distinct operator who notes, acknowledges, replies and resolves it, then participate: discuss and report in a local circle that a granted moderator handles, submit a contribution the moderator returns for correction, offer a private workflow note that an assigned moderator reads until you withdraw permission, and enroll in an invented event. No member activity, study units, support request or review permission is prefilled. Staff setup stays in a private local file; Ctrl+C removes this temporary rehearsal when its connections are closed. See the [owner-run preview guide](assets/docs/OWNER-PRIVATE-PREVIEW.md) for the normal journey, restart instructions and limits.

## Developer setup

Your preview work is stored in local PostgreSQL and accessed through your browser session. Use it on your own computer with sample data.

Prerequisites: Node 24 (`.nvmrc`), Git, Make, Python 3.11+, Docker/Compose with a running daemon.

```sh
make setup
make verify
make dev
```

Open `http://127.0.0.1:3000`. Setup installs locked dependencies, Chromium, Firefox and WebKit for browser checks, the local database and the pre-push hook. It preserves an existing `.env`. See [verification and troubleshooting](assets/docs/workflows/VERIFICATION.md).

The Azure release targets [engine.deepnative.io](https://engine.deepnative.io) with durable PostgreSQL, private evidence storage and guarded deployments from verified `main`. The [Azure release guide](assets/docs/workflows/AZURE-DEMO-DEPLOYMENT.md) covers preservation, restart and rollback; [#45](https://github.com/deepnative/deep-native-engine/issues/45) records the actual deployed revision and public acceptance evidence. Hosting does not activate external AI, payments or qualified assessment. The first durable cutover requires verified preservation of the existing deployment; source/CI alone is not deployment proof.

Email access is off by default. A hosted preview can set both `DNE_EMAIL_ENDPOINT` (the Azure Communication Services HTTPS endpoint) and `DNE_EMAIL_SENDER` (its authorized sender address). The application uses its explicitly selected Azure managed identity; it does not log links or fall back to a local outbox. A generic request acknowledgement is not a delivery receipt: a pending send can be lost on process restart, and the member can request a fresh link after the pending link expires in 15 minutes. Check inbox and spam before requesting again. Configure the service, sender domain and minimum send permission separately, then verify actual delivery before presenting hosted email access as working. No existing member record or cookie is migrated automatically.

Assignment handoff is off by default. Set `DNE_ASSIGNMENT_HANDOFF=enabled` only in the intended runtime to accept a member’s own private assignment text and show the exact-version copy controls. Copies do not grant reviewer access or publish work. Disabling creation preserves existing copy inspection, export and deletion. The [assignment feedback guide](assets/docs/ASSIGNMENT-PRIVATE-FEEDBACK.md) describes consent, source-linked deletion and recovery. Local tests and demonstrations use invented data; hosted availability must be verified separately.

Private support intake is off by default. `DNE_PRIVATE_SUPPORT_INTAKE=enabled` accepts a member's own private request without an invented-data attestation; sending has no charge or guaranteed response time. With existing staff entry and support assignment enabled, a current administrator discovers receipt/lifecycle metadata in the **Support intake inbox** and deliberately assigns a finite exact operator grant. The operator separately acknowledges, keeps internal notes, sends visible replies and resolves; the member can reload replies, export or withdraw. Disabling private intake preserves receipts and privacy controls. See the [private support guide](assets/docs/HOSTED-PRIVATE-SUPPORT.md); hosted staffing still requires an actual named operator, and no identity is provisioned automatically.

The [quality gates](assets/docs/context/QUALITY-GATES.md) and [scope and acceptance](assets/docs/INITIAL-LEARNING-SLICE.md) explain what is tested in this preview and what remains for the full MVP.

Current operators and administrators can open **Learning and participation snapshot** from staff tools for a readable retained-account report: observed activity, self-assessed completion, the bounded return proxy and suppressed/coarse member-reported usefulness. Definitions and deletion limits stay visible, and the existing JSON API remains available. This is a synthetic preview snapshot, not a live business report; see the [metric definitions](assets/docs/CTP-022-LOCAL-METRICS.md).

## Team setup

Read [AGENTS.md](AGENTS.md) and the [team workflow](assets/docs/workflows/TEAM-WORKFLOW.md) before taking an issue. Codex discovers the repo-local skills and custom agents when this repository is opened as a trusted project; reload the project after adding them if needed. Use the same written workflow in other assistants.

| Task                         | Skill                | Suggested role                          |
| ---------------------------- | -------------------- | --------------------------------------- |
| Clarify scope and acceptance | `$dne-plan-issue`    | `dne-planner`                           |
| Deliver an authorized slice  | `$dne-deliver-issue` | `dne-builder` or `dne-critical-builder` |
| Review changes and evidence  | `$dne-review-change` | `dne-reviewer`                          |
| Validate and hand off work   | `$dne-handoff`       | `dne-verifier`                          |

The [documentation index](assets/docs/README.md) includes the original context, model recommendations, templates, and workflow. Shared instructions make the process reproducible; model outputs still require review and tests. Delivery includes merging accepted changes to `main` and verifying the resulting CI.
