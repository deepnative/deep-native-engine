# Public product introduction

The owner authorized a public GitHub Pages introduction on 1 October 2026 in [#420](https://github.com/deepnative/deep-native-engine/issues/420). The public assets are isolated in `site/`. The page explains current learner benefits, the local preview and the wider ecosystem direction; it collects no form submissions and includes no analytics or payment integration.

## Publication and verification

The `Publish product introduction` workflow follows a successful `Repository checks` push run on `main`, or an explicit manual dispatch. It requires a successful repository verification for the exact current main SHA and skips an older event after main advances. Official Pages Actions are pinned. Only `site/` is uploaded, never application source, private test artifacts, PostgreSQL data or environment files. `build.json` records the public commit used for the deployed site so the served page can be checked against the merged revision.

The expected project URL is https://deepnative.github.io/deep-native-engine/; GitHub's Pages API and the actual deployment URL are the authority if the organization uses an inherited domain. Publication is limited to this marketing site. The dynamic app remains a local preview; no product hosting, service purchase, provider, payment or customer outreach is enabled.

## Reviewed verification scope

The repository gate explicitly allows only `site/index.html`, `site/styles.css`, `site/favicon.svg` and the named publication workflow. The public assets are static markup/styles, with no JavaScript or first-party application logic to exclude from unit coverage. The guard rejects unexpected executable site files and scripting in the static markup. Desktop/mobile behavior is checked separately; the application unit metrics and approved journey denominator remain unchanged.

## Keeping the introduction current

When a delivery materially changes what a learner can do, review the current-features and availability copy against README, the product direction and accepted main evidence. Keep aspirations distinct from available behavior. Do not add prices, customer counts, outcome promises, qualified review, live AI or real appointments without their own evidence and authorization. Keep the page concise rather than copying the issue inventory.

For each site change, check desktop and phone rendering, keyboard navigation, expandable FAQ, asset requests, links and horizontal overflow. Complete the repository's exact-commit, pre-push, PR and resulting-main gates, then verify the live page and `build.json`. Revert the site/workflow change through a verified PR to roll back; a manual dispatch can republish only a currently verified main revision.

Official implementation references: [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) and [Pages REST API](https://docs.github.com/en/rest/pages/pages).
