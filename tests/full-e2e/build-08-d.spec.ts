import { test } from "@playwright/test";
import { reviewedContentFixture } from "../support/reviewed-content-browser.ts";
import { requiredCheck } from "../support/required-check.ts";
import {
  deleteAccount,
  expectBackupExpiryNamed,
  expectBillingRetained,
  issuedInvoiceWithPayment,
} from "../support/billing-retention-journey.ts";

// #12 D08 (owner, 10 Nov 2026): after a member with an issued, paid invoice
// deletes their account, the response names the billing exception with its
// six-year CRA expiry and the 30-day backup expiry, and claims no total
// erasure. Invented data on its own database; nothing is payable and no money
// moves. Staff credentials stay out of traces.
test.use({ trace: "off" });

test("[F-BUILD-08-D] the deletion response names the kept billing records and backups with their expiry instead of claiming total erasure", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const f = await reviewedContentFixture(browser, info);
  try {
    await f.publishFixture();
    const admin = (await f.staff("platform_admin")).page;
    const member = await f.member();
    const { invoiceId, reference } = await issuedInvoiceWithPayment(
      f,
      admin,
      member,
    );
    const status = await deleteAccount(f, member);

    await requiredCheck(1, () =>
      expectBillingRetained(f, status, invoiceId, reference),
    );
    await requiredCheck(2, () => expectBackupExpiryNamed(member, status));
  } finally {
    await f.close();
  }
});
