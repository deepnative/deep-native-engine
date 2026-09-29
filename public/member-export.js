export function bindMemberExport(doc, browser) {
  const panel = doc.querySelector("[data-member-export]");
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
      if (blob.size > 256 * 1024) throw new Error("Export page too large");
      const payload = JSON.parse(text);
      const page = payload.page;
      if (
        payload.kind !== "ready" ||
        page.consistency !== "live-pages" ||
        !Number.isSafeInteger(page.number) ||
        page.number < 1 ||
        !Number.isSafeInteger(page.recordCount) ||
        page.recordCount < 0 ||
        page.recordCount > 100 ||
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
        link.download = `deep-native-member-records-page-${page.number}.json`;
        link.click();
      } finally {
        browser.setTimeout(() => browser.URL.revokeObjectURL(url), 0);
      }
      if (page.complete) {
        status.textContent = `Download started for ${page.recordCount} records. Confirm the file was saved before continuing. End of this live traversal. Keep every downloaded page; the final file alone may be incomplete. Start again if records changed during the export.`;
      } else {
        next.href = `/member/export?cursor=${encodeURIComponent(page.nextCursor)}`;
        next.hidden = false;
        status.textContent = `Download started for ${page.recordCount} records. Confirm the file was saved before continuing. Continue to the next page.`;
      }
    } catch {
      status.textContent =
        "This page was not downloaded. Access or continuation may have expired, or the live page changed. Start the export again from your learning space.";
    } finally {
      button.disabled = false;
    }
  });
}

bindMemberExport(document, window);
