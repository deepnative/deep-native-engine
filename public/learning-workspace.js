import { createLearningWorkspaceStorage } from "./learning-workspace-storage.js";

const routes = ["everyday", "work", "technical"];
const moduleBasePattern =
  /^\/learn\/workspace\/content\/(LRN-001)\/(1)\/([a-f0-9]{64})$/;
const csrfPattern = /^[a-f0-9]{64}$/;

export async function bootstrapLearningWorkspace({
  document,
  window,
  importModule = (url) => import(url),
}) {
  const root = document.querySelector("#app");
  if (!root) return { kind: "unavailable" };
  try {
    const match = moduleBasePattern.exec(
      root.dataset.workspaceModuleBase ?? "",
    );
    if (
      !match ||
      !csrfPattern.test(root.dataset.workspaceCsrf ?? "") ||
      !routes.includes(root.dataset.workspaceRoute)
    )
      throw new Error("Invalid learning workspace configuration");
    const [, contentId, version, contentHash] = match;
    const [readerModule, courseModule] = await Promise.all([
      importModule(`${match[0]}/reader.mjs`),
      importModule(`${match[0]}/course.mjs`),
    ]);
    if (
      courseModule.course?.contentHash !== contentHash ||
      courseModule.course.version !== Number(version) ||
      !routes.every((route) => {
        const versions = courseModule.course.feedbackCases?.[route]?.versions;
        const latest = Array.isArray(versions) ? versions.at(-1) : null;
        return (
          Number.isSafeInteger(latest?.id) && typeof latest.text === "string"
        );
      }) ||
      typeof readerModule.mountReader !== "function" ||
      typeof readerModule.emptyState !== "function"
    )
      throw new Error("Learning workspace module unavailable");
    const params = new globalThis.URLSearchParams(
      window.location.hash.slice(1),
    );
    const initialRoute = routes.includes(params.get("route"))
      ? params.get("route")
      : root.dataset.workspaceRoute;
    const storage = createLearningWorkspaceStorage({
      fetch: window.fetch.bind(window),
      csrf: root.dataset.workspaceCsrf,
      randomUUID: window.crypto.randomUUID.bind(window.crypto),
      identity: { contentId, contentVersion: Number(version), contentHash },
      emptyState: readerModule.emptyState,
      feedbackCases: courseModule.course.feedbackCases,
    });
    const reader = await readerModule.mountReader({
      root,
      document,
      window,
      storage,
      initialRoute,
      presentation: {
        accountLabel: "Private to your account",
        onRouteChange(route) {
          if (!routes.includes(route)) return;
          const current = new globalThis.URLSearchParams(
            window.location.hash.slice(1),
          );
          current.set("route", route);
          window.history.replaceState(null, "", `#${current}`);
        },
      },
    });
    return { kind: "ready", reader };
  } catch {
    root.innerHTML = `<main class="workspace-opening"><section class="page-heading" role="alert"><h1>Your practice notebook is unavailable</h1><p>We could not open this lesson. Your saved account work has not been changed. Check your connection or sign in again.</p><p><a href="/learn/records">Open your learning records</a> · <a href="/account">Go to your account</a></p></section></main>`;
    return { kind: "unavailable" };
  }
}

if (globalThis.document && globalThis.window)
  void bootstrapLearningWorkspace({
    document: globalThis.document,
    window: globalThis.window,
  });
