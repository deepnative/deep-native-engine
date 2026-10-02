# Public product introduction

The owner authorized a public GitHub Pages introduction on 1 October 2026 in [#420](https://github.com/deepnative/deep-native-engine/issues/420). The public assets are isolated in `site/`. The page explains current learner benefits, the local preview and the wider ecosystem direction; it collects no form submissions and includes no analytics or payment integration.

## Publication and verification

The `Publish product introduction` workflow follows a successful `Repository checks` push run on `main`, or an explicit manual dispatch. Before checkout, it validates the exact triggering run ID and attempt against GitHub’s run response, the active repository-checks workflow ID/path, repository and head-repository identities, push/main origin, exact current main SHA and completed/success result. It does not require the filtered run list to have refreshed for a workflow-run event. A manual dispatch independently checks the successful-current-main list and then validates a matching exact run. It skips an older event, and checks main again before emitting an eligible SHA. Official Pages Actions are pinned. Only `site/` is uploaded, never application source, private test artifacts, PostgreSQL data or environment files. `build.json` records the public commit used for the deployed site so the served page can be checked against the merged revision.

The expected project URL is https://deepnative.github.io/deep-native-engine/; GitHub's Pages API and the actual deployment URL are the authority if the organization uses an inherited domain. Publication is limited to this marketing site. The dynamic app remains a local preview; no product hosting, service purchase, provider, payment or customer outreach is enabled.

## Eligibility failures and rollback

Missing, malformed, failed or mismatched run evidence and API errors fail closed with a fixed diagnostic; API bodies, credentials and exception details are not printed. Inspect the completed Repository checks run, its attempt and revision, and Actions API access. Do not bypass the selector or rerun tests to conceal a failure. A later rerun attempt cannot establish eligibility for an earlier event. The final main read catches a change observed during lookup; it does not lock the branch against a subsequent push. Checkout remains pinned to the verified SHA.

The repository regression tests execute the actual inline selector with endpoint-specific fake transport responses. They cover exact success with an empty list, identity/result mismatches, stale and changing main, manual-dispatch verification and private error handling. Fixture success is not live publication evidence: inspect the automatic Pages run and public `build.json` separately. This repair authorizes no manual dispatch. Roll back through a verified PR; the older selector still fails closed but can reject valid events before its filtered list refreshes. No application or database migration is involved.

## Reviewed verification scope

The repository gate explicitly allows only `site/index.html`, `site/styles.css`, `site/favicon.svg` and the named publication workflow. The public assets are static markup/styles, with no JavaScript or first-party application logic to exclude from unit coverage. The guard rejects unexpected executable site files and scripting in the static markup. Desktop/mobile behavior is checked separately; the application unit metrics and approved journey denominator remain unchanged.

## Keeping the introduction current

When a delivery materially changes what a learner can do, review the current-features and availability copy against README, the product direction and accepted main evidence. Keep aspirations distinct from available behavior. Do not add prices, customer counts, outcome promises, qualified review, live AI or real appointments without their own evidence and authorization. Keep the page concise rather than copying the issue inventory.

For each site change, check desktop and phone rendering, keyboard navigation, expandable FAQ, asset requests, links and horizontal overflow. Complete the repository's exact-commit, pre-push, PR and resulting-main gates, then verify the live page and `build.json`. Revert the site/workflow change through a verified PR to roll back; a manual dispatch can republish only a currently verified main revision.

Selector API references: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and [workflow-run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

Official implementation references: [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) and [Pages REST API](https://docs.github.com/en/rest/pages/pages).
