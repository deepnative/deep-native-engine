import { mountReader } from "./reader.mjs";

await mountReader({
  root: document.querySelector("#app"),
  document,
  window,
});
