import { OPERATOR_STATEMENT } from "./customer-market.ts";
import { escape, page } from "./views.ts";

// #12 owner decisions of 9 November 2026. The owner accepted this drafted text
// for the demo only. It is not legally reviewed, and a qualified review is
// needed before any launch (launch is no-go). Plain facts, not legal wording.
export const SERVICE_CONTACT = "info@deepnative.io";
export const BACKUP_RETENTION_DAYS = 30;

const contact = `<a href="mailto:${SERVICE_CONTACT}">${SERVICE_CONTACT}</a>`;

/** TERMS-01..03: one public page for the demo's terms and privacy. */
export function termsPage() {
  return page(
    "Terms and privacy",
    `<section class="reading"><p class="eyebrow">DEMO TERMS · NOT LEGALLY REVIEWED</p><h1>Terms and privacy for this demo</h1><p class="lead" role="note"><strong>Accepted by Deep Native Inc. for this demo only. Not legally reviewed.</strong></p><p>Deep Native Engine has not launched. This is a demo with test data only, so don't enter real personal, client or payment details. A qualified legal review is needed before any launch, and these terms may change after it.</p>
<h2>Who runs it</h2><p>${escape(OPERATOR_STATEMENT)}</p>
<h2>Your account and work</h2><p>What you save stays private to your account until you choose to share it. You can download your records or delete your account from My account.</p>
<h2>No recording</h2><p>Sessions, coaching, events and circles are not recorded. No audio or video is captured.</p>
<h2>Backups and deletion</h2><p>Database backups are kept for up to ${BACKUP_RETENTION_DAYS} days, then they expire. Deleting your account removes it from the service straight away. Copies in backups go when those backups expire, within ${BACKUP_RETENTION_DAYS} days. My account lists the few records kept after deletion, such as issued invoices.</p>
<h2>AI and payments</h2><p>No AI provider is connected; AI results here are simulated. The service takes no card or bank details.</p>
<h2>Contact</h2><p>For privacy questions, support, or to report a problem in a circle or shared space, email ${contact}.</p></section>`,
  );
}
