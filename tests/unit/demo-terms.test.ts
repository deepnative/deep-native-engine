import { expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { termsPage } from "../../src/demo-terms.ts";
import { deletionKept } from "../../src/views.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #12 owner decisions of 9 November 2026: the drafted terms are accepted for
// the demo only and are not legally reviewed; no session recording; 30-day
// backups; info@deepnative.io for privacy, support and moderation; no launch.
const origin = "http://127.0.0.1:3000";
const host = "127.0.0.1:3000";
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();

function storage() {
  return {
    session: async () => ({ kind: "new" }),
  } as never;
}
async function visit(path: string) {
  return withLoopback(app(storage(), { origin, secret: "terms-test" }), (s) =>
    request(s).get(path).set("Host", host),
  );
}

it.each([true, false])(
  "TERMS-01 the terms page (hosted %s) is accepted for the demo only, not legally reviewed, and says the service has not launched",
  (hosted) => {
    const page = text(withHosting(hosted, () => termsPage()));
    expect(page).toContain("Terms and privacy for this demo");
    expect(page).toContain(
      "Accepted by Deep Native Inc. for this demo only. Not legally reviewed.",
    );
    expect(page).toContain(
      "Deep Native Engine has not launched. This is a demo with test data only, so don't enter real personal, client or payment details.",
    );
    expect(page).toContain(
      "A qualified legal review is needed before any launch, and these terms may change after it.",
    );
  },
);

it("TERMS-02 the terms page names the operator and one contact for privacy, support and moderation", () => {
  const html = withHosting(true, () => termsPage());
  expect(text(html)).toContain(
    "Deep Native Engine is operated by Deep Native Inc. in Ontario, Canada, and is offered to people living in Canada for now.",
  );
  expect(text(html)).toContain(
    "For privacy questions, support, or to report a problem in a circle or shared space, email info@deepnative.io.",
  );
  expect(html).toContain(
    '<a href="mailto:info@deepnative.io">info@deepnative.io</a>',
  );
});

it("TERMS-03 the terms page says nothing is recorded, how long backups last, and that no payment details are taken", () => {
  const page = text(withHosting(true, () => termsPage()));
  for (const sentence of [
    "Sessions, coaching, events and circles are not recorded. No audio or video is captured.",
    "Database backups are kept for up to 30 days, then they expire.",
    "Deleting your account removes it from the service straight away, except for the records below. Copies in backups go when those backups expire, within 30 days.",
    "The service takes no card or bank details.",
  ])
    expect(page).toContain(sentence);
});

it("TERMS-01/04 /terms is public, and every page's footer links to it", async () => {
  const terms = await visit("/terms");
  expect(terms.status).toBe(200);
  expect(terms.text).toContain("<h1>Terms and privacy for this demo</h1>");
  const footer =
    (await visit("/readiness")).text.match(
      /<footer[^>]*>([\s\S]*?)<\/footer>/,
    )?.[1] ?? "";
  expect(footer).toContain('<a href="/terms">Terms and privacy</a>');
});

// #12 D08, owner decision 10 Nov 2026: invoices and payment records are kept
// six years (CRA); backups 30 days. /terms lists the same kept records as the
// account page, from the same source.
it("RETAIN-01/02 /terms names the billing exception with its expiry and the backup expiry, and lists the same kept records as My account", () => {
  const html = withHosting(true, () => termsPage());
  const page = text(html);
  for (const sentence of [
    "Issued invoices and the payments and refunds recorded against them are kept for 6 years after the account is deleted, following Canada Revenue Agency record-keeping rules (records are kept 6 years from the end of the last tax year they relate to).",
    "They hold only what the invoice needs: its number and date, the issuer, the billing name, company and email, the items, amounts and tax, whether it was voided, and the payments and refunds recorded. Sample invoices are deleted with the account.",
    "Copies in service backups are kept for up to 30 days, then they expire.",
  ])
    expect(page).toContain(sentence);
  expect(html).toContain(withHosting(true, () => deletionKept()));
  expect(page).toContain("Not legally reviewed.");
  expect(page).not.toMatch(
    /all (of )?your data|everything is (deleted|erased)|permanently erased/i,
  );
});
