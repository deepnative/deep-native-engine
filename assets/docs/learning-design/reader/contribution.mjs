import { course } from "./course.mjs";

export const contributionFields = [
  ["problem", "Problem and source version"],
  ["first", "First proposal"],
  ["revision", "Revised proposal (optional)"],
  ["reason", "Reason and evidence"],
  ["rights", "Sources and rights note"],
  ["attribution", "Intended attribution (optional)"],
];
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function newContribution() {
  return {
    ...Object.fromEntries(contributionFields.map(([key]) => [key, ""])),
    audience: "private",
    checked: false,
  };
}
export function contributionReady(value) {
  return (
    ["problem", "first", "reason", "rights"].every((key) =>
      value[key].trim(),
    ) &&
    (value.audience === "private" || Boolean(value.attribution.trim()))
  );
}
export function validContribution(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    contributionFields.every(
      ([key]) => typeof value[key] === "string" && value[key].length <= 30000,
    ) &&
    ["private", "members-later"].includes(value.audience) &&
    typeof value.checked === "boolean" &&
    (!value.checked || contributionReady(value)),
  );
}
export function renderContribution(value, account = false) {
  return `<section class="contribution-workspace" id="contribution-workspace"><details id="contribution-panel"><summary>Shape a contribution (optional)</summary>
    <h2>Help someone use your improvement.</h2>${course.contribution.intro}
    <div class="source-card" id="contribution-source">${course.contribution.source}</div>
    <div id="contribution-teaching">${course.contribution.teaching}</div>
    ${course.contribution.prompt}
    <div class="contribution-fields">${contributionFields.map(([key, label]) => `<div><label class="writing-label" for="contribution-${key}">${label}</label><textarea id="contribution-${key}" data-contribution-field="${key}" rows="${key === "attribution" ? 2 : key === "problem" ? 3 : ["first", "revision"].includes(key) ? 8 : 6}" maxlength="30000">${escape(value[key])}</textarea></div>`).join("")}</div>
    <label class="writing-label" for="contribution-audience">Intended audience</label><select id="contribution-audience"><option value="private"${value.audience === "private" ? " selected" : ""}>Keep this draft private</option><option value="members-later"${value.audience === "members-later" ? " selected" : ""}>Consider member-only sharing later</option></select>
    <p class="quiet">An audience plan is not permission. Only a later explicit choice on the member site can share an accepted revision.</p>
    <button class="secondary" id="contribution-cancel" type="button"${value.audience === "private" && !value.attribution ? " disabled" : ""}>Cancel this sharing plan</button>
    <label class="self-check"><input id="contribution-check" type="checkbox"${value.checked ? " checked" : ""}${contributionReady(value) ? "" : " disabled"}>I checked this proposal against its source and sharing boundaries</label>
    <p class="quiet">Complete the problem, first proposal, reason and rights note to record your self-check. For a future member audience, also choose intended attribution. Unfinished drafts can still be saved.</p>
    <p id="contribution-status" role="status">Not submitted or shared. Use ${account ? "Save my work" : "Save in this browser"} or Download my work to retain this private practice.</p>
  </details></section>`;
}
export function bindContribution(value, changed, document) {
  const refresh = () => {
    const checked = document.querySelector("#contribution-check");
    checked.checked = value.checked;
    checked.disabled = !contributionReady(value);
    document.querySelector("#contribution-cancel").disabled =
      value.audience === "private" && !value.attribution;
  };
  const edit = () => {
    value.checked = false;
    refresh();
    changed();
  };
  document.querySelectorAll("[data-contribution-field]").forEach((input) =>
    input.addEventListener("input", () => {
      value[input.dataset.contributionField] = input.value;
      edit();
    }),
  );
  document
    .querySelector("#contribution-audience")
    ?.addEventListener("change", (event) => {
      value.audience = event.target.value;
      edit();
    });
  document
    .querySelector("#contribution-check")
    ?.addEventListener("change", (event) => {
      value.checked = event.target.checked && Boolean(contributionReady(value));
      changed();
    });
  document
    .querySelector("#contribution-cancel")
    ?.addEventListener("click", () => {
      value.audience = "private";
      value.attribution = "";
      document.querySelector("#contribution-audience").value = "private";
      document.querySelector("#contribution-attribution").value = "";
      edit();
      document.querySelector("#contribution-status").textContent =
        "Sharing plan cancelled; private draft retained. Not submitted or shared. This does not withdraw a permission on the member site.";
    });
}
export function exportContribution(value, plain) {
  return [
    "Optional contribution practice",
    plain(course.contribution.source),
    "Not submitted or shared. No real editorial review or display permission.",
    ...contributionFields.map(([key, label]) => `${label}: ${value[key]}`),
    `Intended audience: ${value.audience === "private" ? "Keep this draft private" : "Member-only sharing considered for later"}`,
    `Proposal self-checked by learner: ${value.checked ? "yes" : "no"}`,
  ].join("\n\n");
}
