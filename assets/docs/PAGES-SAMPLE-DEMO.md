# GitHub Pages sample walkthrough

This separate, browser-only sample is scoped by [#535](https://github.com/deepnative/deep-native-engine/issues/535). It is not a portal replacement. [Open the existing user portal](https://engine.deepnative.io/learn) for the Azure application and its saved sample work.

At [the Pages sample](https://deepnative.io/deep-native-engine/#sample-demo), choose a general, professional or technical learning direction. Read the invented workshop brief, write an instruction using only those details, and choose **Save sample draft**. Reload in the same tab to resume at 0/1. Check your instruction against the brief, tick the self-check and choose **Complete sample**. Reload to see the exact saved response and 1/1 sample completion. Editing requires a fresh self-check. **Reset this sample** removes only its browser-tab record.

Use invented information. Actions are simulated; no account, provider call, qualified assessment, upload or backend write occurs. The single `dne-pages-demo-v1` session-storage key belongs to this sample. This sample is not synced to an account; use Reset this sample to remove its saved record. Unavailable storage is reported honestly; retain a copy before leaving. Malformed records are not silently deleted. Without JavaScript the brief and portal link remain readable and sample controls stay disabled.

## Acceptance mapping

| Scenario      | AC         | Approved journey | Evidence                                                                                |
| ------------- | ---------- | ---------------- | --------------------------------------------------------------------------------------- |
| PAGES-DEMO-01 | PD-AC1/2/4 | L210             | All three directions, exact draft/completion reload, separate portal, no network writes |
| PAGES-DEMO-02 | PD-AC2/3   | L211             | Validation focus/text retention, renewed self-check, namespaced reset                   |
| PAGES-DEMO-03 | PD-AC3/4   | L212             | Malformed record, denied write, recovery and no-script path                             |

Executable tests: `tests/unit/pages-demo.test.mjs`, `tests/e2e/pages-demo.spec.ts` on the existing desktop/mobile projects, plus the repository public-asset boundary checks. Register v107 adds these three critical scenarios to the original 209/208 critical (212 total/211 critical, 424 required browser executions); original IDs, six cross-browser cases, provisional inventory and full-MVP denominator remain unchanged. A passing sample does not establish full-MVP acceptance.

The verified-main Pages workflow stages only `site/`, the exact covered `public/pages-demo.js` module and the build revision. The backend is not copied into Pages. For a local read-only preview, copy `site/` into a temporary directory, copy `public/pages-demo.js` to its `demo.js`, and serve that directory using the existing Python HTTP server bound to loopback on an unused port. Stop that server to end the preview. No database or Azure restart is involved.
