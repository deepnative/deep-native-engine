// The local practice reader keeps its original explicit browser-save format.
// Account storage is injected by the member app and never passes through here.
export function createBrowserNotebook({
  storage,
  contentHash,
  validState,
  emptyState,
}) {
  const legacyKey = (route) => `dne-course-reader-1:${route}`;
  const key = (route) => `${legacyKey(route)}:${contentHash}`;

  return {
    mode: "browser",
    load(route) {
      const result = {
        state: emptyState(route),
        view: "learn",
        raw: null,
        earlier: [],
        blocked: false,
        message:
          "Nothing saved yet. Your writing stays here while this page is open.",
      };
      let loadedKey;
      try {
        const currentRaw = storage.getItem(key(route));
        loadedKey = currentRaw !== null ? key(route) : legacyKey(route);
        result.raw = currentRaw ?? storage.getItem(loadedKey);
        for (const storedKey of Object.keys(storage).sort()) {
          if (
            storedKey !== key(route) &&
            (storedKey === legacyKey(route) ||
              storedKey.startsWith(`${legacyKey(route)}:`))
          )
            result.earlier.push({
              key: storedKey,
              raw: storage.getItem(storedKey),
            });
        }
        if (result.raw !== null) {
          const stored = JSON.parse(result.raw);
          if (stored.version !== 1 || typeof stored.contentHash !== "string")
            throw new Error("different version");
          if (stored.route !== route) throw new Error("unreadable");
          if (stored.contentHash !== contentHash) {
            if (loadedKey === key(route)) throw new Error("different version");
            result.raw = null;
          } else {
            if (!validState(stored.state, route)) throw new Error("unreadable");
            result.state = stored.state;
            result.view = "lesson";
            result.state.finalStep ??= 0;
            result.state.reviewCriterion ??= null;
            result.earlier = result.earlier.filter(
              (entry) => entry.key !== loadedKey,
            );
            result.message =
              "Restored your explicit browser save. This is not a member-account save.";
          }
        }
        if (result.raw === null && result.earlier.length)
          result.message =
            "An earlier content version is saved separately below. Start a current notebook here; earlier answers and self-checks have not been copied.";
      } catch (error) {
        result.blocked = result.raw !== null;
        result.earlier = result.earlier.filter(
          (entry) => entry.key !== loadedKey,
        );
        result.message = result.blocked
          ? `Saved work could not be restored${error.message === "different version" ? " because the lesson version differs" : " because the record is unreadable"}. The stored copy is unchanged. Download it before moving work to a new version.`
          : "Browser storage is unavailable. You can still practise and download your work.";
      }
      return result;
    },
    save({ route, immutableState }) {
      const raw = JSON.stringify({
        version: 1,
        contentHash,
        route,
        state: immutableState,
        savedAt: new Date().toISOString(),
      });
      storage.setItem(key(route), raw);
      return { kind: "saved", raw };
    },
  };
}
