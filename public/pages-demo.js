const KEY = "dne-pages-demo-v1";
const DIRECTIONS = ["general", "professional", "technical"];

export function readSample(raw) {
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !DIRECTIONS.includes(value.direction) ||
    typeof value.response !== "string" ||
    value.response.length > 1200 ||
    typeof value.checked !== "boolean" ||
    typeof value.completed !== "boolean" ||
    (value.completed && (!value.response.trim() || !value.checked))
  ) {
    throw new Error("Invalid browser sample");
  }
  return value;
}

export function bindPagesDemo(doc, browser) {
  const panel = doc.querySelector("#sample-demo");
  if (!panel) return;
  const direction = panel.querySelector("#demo-direction");
  const response = panel.querySelector("#demo-response");
  const checked = panel.querySelector("#demo-check");
  const status = panel.querySelector("#demo-status");
  const progress = panel.querySelector("#demo-progress");
  const save = panel.querySelector("#demo-save");
  const complete = panel.querySelector("#demo-complete");
  const reset = panel.querySelector("#demo-reset");
  const showProgress = (done) => {
    progress.textContent = `${done ? 1 : 0} / 1 sample completed`;
  };
  try {
    const stored = readSample(browser.sessionStorage.getItem(KEY));
    if (stored) {
      direction.value = stored.direction;
      response.value = stored.response;
      checked.checked = stored.checked;
      showProgress(stored.completed);
      status.textContent = "Restored the sample saved in this browser tab.";
    }
  } catch {
    status.textContent =
      "Your saved sample could not be read. Start a new sample here; no stored data was changed. Saving may be unavailable in this browser.";
  }

  const saveSample = (completed) => {
    let problem;
    if (!DIRECTIONS.includes(direction.value)) {
      problem = [direction, "Choose your learning direction first."];
    } else if (response.value.length > 1200) {
      problem = [
        response,
        "Keep your sample response within 1,200 characters.",
      ];
    } else if (completed && !response.value.trim()) {
      problem = [
        response,
        "Write a sample response before completing this exercise.",
      ];
    } else if (completed && !checked.checked) {
      problem = [
        checked,
        "Check your sample against the details, then tick the self-check.",
      ];
    }
    if (problem) {
      status.textContent = problem[1];
      problem[0].focus();
      return;
    }
    const value = {
      version: 1,
      direction: direction.value,
      response: response.value,
      checked: checked.checked,
      completed,
    };
    try {
      browser.sessionStorage.setItem(KEY, JSON.stringify(value));
      showProgress(completed);
      status.textContent = completed
        ? "Sample completed and saved in this browser tab. This is your self-check, not an assessment."
        : "Sample draft saved in this browser tab. Reload here to continue.";
    } catch {
      progress.textContent = "Sample changes not saved";
      status.textContent =
        "Browser-tab storage is unavailable. Your response is still here, but these changes are not saved. Keep a copy before leaving.";
    }
  };
  const changed = () => {
    checked.checked = false;
    progress.textContent = "Unsaved sample changes";
    status.textContent =
      "Choose Save sample draft, or self-check and Complete sample.";
  };
  direction.addEventListener("change", changed);
  response.addEventListener("input", changed);
  checked.addEventListener("change", () => {
    progress.textContent = "Unsaved sample changes";
    status.textContent = "Your self-check has changed. Choose a save action.";
  });
  save.addEventListener("click", () => saveSample(false));
  complete.addEventListener("click", () => saveSample(true));
  reset.addEventListener("click", () => {
    direction.value = "";
    response.value = "";
    checked.checked = false;
    showProgress(false);
    try {
      browser.sessionStorage.removeItem(KEY);
      status.textContent =
        "Sample reset. Other browser data and your user portal are unchanged.";
    } catch {
      status.textContent =
        "Cleared this page, but could not remove the saved sample. It may return on reload. Other browser data was not changed.";
    }
  });
  for (const control of [direction, response, checked, save, complete, reset]) {
    control.disabled = false;
  }
}

bindPagesDemo(document, window);
