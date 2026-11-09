import { readableTime } from "./display-time.ts";
import type {
  RecordAccessEntry,
  RecordScope,
} from "./member-record-access.ts";
import { escape, hidden, page } from "./views.ts";

export const RECORD_ACCESS_PATH = "/account/record-access";
export const OPERATOR_RECORDS_PATH = "/operator/member-records";
const TITLE = "Let operators download my records";
const OPERATOR_TITLE = "Download a member's records";

export const RECORD_SCOPE_NAMES: Record<RecordScope, string> = {
  learning: "learning records",
  support: "support requests",
  billing: "billing records",
};
const SCOPE_DETAILS: Record<RecordScope, string> = {
  learning:
    "Lessons you opened and rated, assignments you chose and your answers, practice exercises, milestones and assessment results.",
  support:
    "Your support requests: subject, message and status. Withdrawn requests show no text.",
  billing:
    "Your billing name and email, invoices, payments and refunds on them, course offers, and test payment records.",
};
const SCOPES = Object.keys(RECORD_SCOPE_NAMES) as RecordScope[];
const time = (at: Date) =>
  `<time datetime="${at.toISOString()}">${readableTime(at)}</time>`;
const downloads = (n: number) =>
  n === 0 ? "No downloads yet." : n === 1 ? "Downloaded once." : `Downloaded ${n} times.`;

function entry(item: RecordAccessEntry, csrf: string) {
  const name = RECORD_SCOPE_NAMES[item.scope];
  const state = item.current
    ? `Allowed until ${time(item.expiresAt)}.`
    : item.revokedAt
      ? `You stopped it on ${time(item.revokedAt)}.`
      : `Ended on ${time(item.expiresAt)}.`;
  const revoke = item.current
    ? `<form method="post" action="${RECORD_ACCESS_PATH}/${escape(item.id)}/revoke">${hidden(csrf)}<button type="submit" class="secondary">Stop operators downloading my ${name}</button></form>`
    : "";
  return `<li data-record-access="${escape(item.scope)}"><strong>${name[0]!.toUpperCase()}${name.slice(1)}</strong><p>Given ${time(item.createdAt)}. ${state} ${downloads(item.downloads)}</p>${revoke}</li>`;
}

/** #40 RECACCESS: the member's own permissions; every change is a form here. */
export function recordAccessPage(
  entries: RecordAccessEntry[],
  csrf: string,
  reference: string,
) {
  const current = entries.filter((item) => item.current);
  const ended = entries.filter((item) => !item.current);
  const open = SCOPES.filter(
    (scope) => !current.some((item) => item.scope === scope),
  );
  const form = open.length
    ? `<form method="post" action="${RECORD_ACCESS_PATH}"><fieldset><legend>Which records may operators download?</legend>${open
        .map(
          (scope, index) =>
            `<label class="check"><input type="radio" name="scope" value="${scope}"${index === 0 ? " checked" : ""} required> ${RECORD_SCOPE_NAMES[scope][0]!.toUpperCase()}${RECORD_SCOPE_NAMES[scope].slice(1)}<br><span class="hint">${SCOPE_DETAILS[scope]}</span></label>`,
        )
        .join(
          "",
        )}</fieldset>${hidden(csrf)}<button type="submit">Allow for 7 days</button></form>`
    : "<p>Operators may already download every kind of record listed here.</p>";
  return page(
    TITLE,
    `<section class="reading"><p class="eyebrow">My account</p><h1>${TITLE}</h1><p class="lead">If you ask an operator for help with your records, you can let them download one kind of record for seven days. You can stop it at any time.</p><p>They also need your student reference: <code>${escape(reference)}</code>. Without your permission, operators can't download your records, and they never get your other records, your files or another member's records.</p><p>Each download is listed in <a href="/account/sharing/staff-access">When staff opened my work</a>, without the operator's name.</p></section>
<section class="reading" aria-labelledby="record-access-current"><h2 id="record-access-current">Allowed now</h2>${
      current.length
        ? `<ul>${current.map((item) => entry(item, csrf)).join("")}</ul>`
        : '<p role="status">Operators can\'t download any of your records right now.</p>'
    }</section>
<section class="reading" aria-labelledby="record-access-new"><h2 id="record-access-new">Allow a download</h2>${form}</section>${
      ended.length
        ? `<section class="reading" aria-labelledby="record-access-ended"><h2 id="record-access-ended">Ended</h2><ul>${ended.map((item) => entry(item, csrf)).join("")}</ul><p>Only your 20 most recent permissions are shown here. All of them are in <a href="/member/export">Download my records</a>, in the section called recordAccess.</p></section>`
        : ""
    }<section class="reading"><p><a href="/account/sharing">Who can see my work</a> · <a href="/account">My account</a></p></section>`,
  );
}

export function recordAccessRefusal(
  status: "invalid" | "unavailable",
): [number, string] {
  return status === "invalid"
    ? [
        400,
        page(
          TITLE,
          `<section class="reading"><h1>Nothing changed</h1><p>Choose one kind of record from the form, or open this page again from My account.</p><p><a href="${RECORD_ACCESS_PATH}">${TITLE}</a></p></section>`,
        ),
      ]
    : [
        503,
        page(
          TITLE,
          `<section class="reading"><h1>Your permissions can't be checked right now</h1><p>Try again shortly. Nothing you allowed has changed.</p><p><a href="/account">My account</a></p></section>`,
        ),
      ];
}

/** The operator's form; the download itself is JSON. */
export function operatorRecordsPage(csrf: string) {
  return page(
    OPERATOR_TITLE,
    `<section class="reading"><p class="eyebrow">Operator</p><h1>${OPERATOR_TITLE}</h1><p class="lead">You can download a member's records only after they allow it on their account, for one kind of record at a time and for seven days at most.</p><p>Ask the member for their student reference. The download has only the kind of record they allowed. Each download is shown to the member, but your name isn't.</p><form method="post" action="${OPERATOR_RECORDS_PATH}">${hidden(csrf)}<label for="reference">Student reference</label><input id="reference" name="reference" required autocomplete="off" spellcheck="false" maxlength="36"><label for="scope">Records</label><select id="scope" name="scope">${SCOPES.map((scope) => `<option value="${scope}">${RECORD_SCOPE_NAMES[scope][0]!.toUpperCase()}${RECORD_SCOPE_NAMES[scope].slice(1)}</option>`).join("")}</select><label for="cursor">Next page code (optional)</label><input id="cursor" name="cursor" autocomplete="off" spellcheck="false" maxlength="1024"><p class="hint">A download has up to 100 records. If there are more, it ends with a nextCursor code. Paste that code here, with the same reference and kind of record, within 15 minutes.</p><button type="submit">Download records</button></form></section>`,
  );
}

export function operatorRecordsRefusal(
  kind: "denied" | "invalid" | "limit" | "unavailable",
): [number, string] {
  const [status, heading, text] = {
    denied: [
      403,
      "Download refused",
      "Nothing was downloaded. Either this member hasn't allowed operators to download these records right now, the reference is wrong, or your session can't use this page. Ask the member to check Let operators download my records on their account.",
    ],
    invalid: [
      400,
      "Download refused",
      "Nothing was downloaded. Enter a student reference and choose one kind of record.",
    ],
    limit: [
      413,
      "Download too large",
      "Nothing was downloaded. One record is larger than a download can hold.",
    ],
    unavailable: [
      503,
      "Download unavailable",
      "Nothing was downloaded. Try again shortly.",
    ],
  }[kind] as [number, string, string];
  return [
    status,
    page(
      OPERATOR_TITLE,
      `<section class="reading"><h1>${heading}</h1><p>${text}</p><p><a href="${OPERATOR_RECORDS_PATH}">${OPERATOR_TITLE}</a></p></section>`,
    ),
  ];
}
