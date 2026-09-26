const form = document.querySelector("form[data-attempt-save]");

if (form) {
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('[role="status"]');

  form.addEventListener("submit", () => {
    button.disabled = true;
    status.hidden = false;
  });

  // A browser may restore the form from its back/forward cache after a write.
  // Its prior pending state is not evidence that a new request is in flight.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      button.disabled = false;
      status.hidden = true;
    }
  });
}
