export function bindEvidenceExport(doc, browser) {
  const panel = doc.querySelector("[data-evidence-export]");
  if (!panel) return;
  const button = panel.querySelector("button");
  const status = panel.querySelector('[role="status"]');
  const next = panel.querySelector("[data-export-next]");
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    next.hidden = true;
    next.removeAttribute("href");
    status.textContent = "Reading this live page…";
    try {
      const response = await browser.fetch(panel.dataset.url, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Export unavailable");
      const text = await response.text();
      const blob = new browser.Blob([text], { type: "application/json" });
      if (blob.size > 6 * 1024 * 1024) throw new Error("Export page too large");
      const payload = JSON.parse(text);
      const page = payload.page;
      if (
        payload.kind !== "ready" ||
        payload.version !== "local-evidence-v2" ||
        !Array.isArray(payload.items) ||
        page.consistency !== "live-pages" ||
        !Number.isSafeInteger(page.number) ||
        page.number < 1 ||
        !Number.isSafeInteger(page.itemCount) ||
        page.itemCount < 0 ||
        page.itemCount > 20 ||
        payload.items.length !== page.itemCount ||
        !Number.isSafeInteger(page.sourceBytes) ||
        page.sourceBytes < 0 ||
        page.sourceBytes > 4 * 1024 * 1024 ||
        typeof page.complete !== "boolean" ||
        (page.complete
          ? page.nextCursor !== null
          : typeof page.nextCursor !== "string" || !page.nextCursor)
      )
        throw new Error("Export page invalid");
      const url = browser.URL.createObjectURL(blob);
      try {
        const link = doc.createElement("a");
        link.href = url;
        link.download = `deep-native-evidence-page-${page.number}.json`;
        link.click();
      } finally {
        browser.setTimeout(() => browser.URL.revokeObjectURL(url), 0);
      }
      if (page.complete) {
        status.textContent = `Download started for ${page.itemCount} samples. Confirm the file was saved before continuing. End of this live traversal. Keep every downloaded page; the final file alone may be incomplete. Start again if samples changed during the export.`;
      } else {
        next.href = `/evidence/export?cursor=${encodeURIComponent(page.nextCursor)}`;
        next.hidden = false;
        status.textContent = `Download started for ${page.itemCount} samples. Confirm the file was saved before continuing. Continue to the next page.`;
      }
    } catch {
      status.textContent =
        "This page was not downloaded. Access or continuation may have expired, or the live page changed. Start the export again from your private evidence.";
    } finally {
      button.disabled = false;
    }
  });
}

bindEvidenceExport(document, window);
