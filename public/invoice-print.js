// #854 PAGE854-02: the administrator's Print button. It stays hidden until
// this script runs; without scripts the page keeps its printing hint.
export function bindInvoicePrint(doc, view) {
  for (const button of doc.querySelectorAll("button[data-print]")) {
    button.addEventListener("click", () => view.print());
    button.hidden = false;
  }
}

bindInvoicePrint(document, window);
