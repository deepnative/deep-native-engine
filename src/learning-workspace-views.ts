import { escape } from "./views.ts";
import { LEARNING_WORKSPACE_ASSET_BASE } from "./learning-workspace-assets.ts";
import type { LearningVariant } from "./learning-workspace-values.ts";

export function learningWorkspacePage(route: LearningVariant, csrf: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>AI, put to practice · Deep Native</title><link rel="stylesheet" href="${LEARNING_WORKSPACE_ASSET_BASE}/style.css"></head>
<body><header class="account-navigation"><span>Signed in</span><nav aria-label="Account and learning services"><a href="/account">My account</a><a href="/learn/notebooks">Saved notebooks</a><a href="/learn/records">Learning records</a><a href="/support">Course support</a><a href="/member/export">Download my records</a></nav></header>
<div id="app" data-workspace-module-base="${LEARNING_WORKSPACE_ASSET_BASE}" data-workspace-csrf="${escape(csrf)}" data-workspace-route="${escape(route)}"><p class="workspace-opening" role="status">Opening your private learning notebook…</p></div>
<noscript><p class="workspace-opening">This practice notebook needs JavaScript. You can still <a href="/learn/records">open your earlier lessons and assignments</a> or <a href="/member/export">download your saved records</a>.</p></noscript>
<script type="module" src="/assets/learning-workspace.js"></script></body></html>`;
}
