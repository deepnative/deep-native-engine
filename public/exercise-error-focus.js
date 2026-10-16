export function bindExerciseErrorFocus(doc) {
  const summary = doc.querySelector("[data-exercise-errors]");
  if (!summary) return;

  for (const link of summary.querySelectorAll('a[href^="#"]')) {
    link.addEventListener("click", (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;

      const target = doc.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      event.preventDefault();
      target.focus();
      // Establish an editable caret without replacing the learner's text.
      if (target.tagName === "TEXTAREA")
        target.setSelectionRange(target.value.length, target.value.length);
    });
  }
}

bindExerciseErrorFocus(document);
