import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { testPool } from "../support/database.ts";
import { jobStore, requestFingerprint } from "../../src/jobs.ts";
import { evidenceStore, fileObjectStorage } from "../../src/evidence.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function memberId(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const row = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(row.rowCount).toBe(1);
  return row.rows[0]!.id;
}

test("[L61] current owner downloads private structured records while unrelated, revoked, deleting and expired access is denied", async ({
  page,
  context,
  browser,
}) => {
  const otherContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  try {
    const otherPage = await otherContext.newPage();
    await onboard(page);
    await onboard(otherPage);
    const ownerId = await memberId(context);
    await pool.query(
      `INSERT INTO learning_milestones(id,member_id,goal_title,milestone_title,next_action)
       VALUES($1,$2,'Invented goal','Owner-only milestone','Review next step')`,
      [randomUUID(), ownerId],
    );
    const ownerToken = (await context.cookies()).find(
      (item) => item.name === "dne_preview",
    )!.value;
    const source = await evidenceStore(
      pool,
      fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
      "browser-secret",
    ).upload(ownerToken, {
      name: `export-local-ai-${randomUUID()}.txt`,
      mediaType: "text/plain",
      data: Buffer.from("Invented export receipt source"),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    expect(source.kind).toBe("created");
    if (source.kind !== "created") throw Error("Synthetic source unavailable");
    expect(
      await evidenceStore(
        pool,
        fileObjectStorage(process.env.DNE_TEST_PRIVATE_STORAGE_ROOT!),
        "browser-secret",
      ).transitionQuarantine(source.id, "clean"),
    ).toBe(true);
    await expect(
      page.getByRole("link", {
        name: "Download my structured preview records",
      }),
    ).toBeVisible();
    await page.goto("/evidence/local-ai");
    await page
      .getByLabel("I permit this exact invented sample version")
      .check();
    await page
      .getByRole("button", { name: "Grant local simulation permission" })
      .click();
    const receiptId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM local_ai_receipts WHERE evidence_id=$1 AND withdrawn_at IS NULL",
        [source.id],
      )
    ).rows[0]!.id;
    await page.getByRole("button", { name: "Queue local simulation" }).click();
    const jobId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM adapter_jobs WHERE local_ai_receipt_id=$1",
        [receiptId],
      )
    ).rows[0]!.id;
    const own = await page.request.get("/api/member/export");
    expect(own.status()).toBe(200);
    expect(own.headers()["content-disposition"]).toContain(
      "deep-native-member-records-page-1.json",
    );
    expect(own.headers()["cache-control"]).toBe("no-store");
    const granted = await own.json();
    expect(granted.records.localAiReceipts).toMatchObject([
      { id: receiptId, evidenceId: source.id },
    ]);
    expect(granted).toMatchObject({
      version: "local-member-records-v15",
      profile: { id: ownerId },
      records: {
        milestones: [{ milestoneTitle: "Owner-only milestone" }],
        localAiReceipts: [
          {
            id: receiptId,
            evidenceId: source.id,
            revisionNumber: 1,
            purpose: "evidence-summary-local-v1",
            statementVersion: "local-simulation-v1",
            withdrawnAt: null,
          },
        ],
      },
    });
    expect(
      granted.records.adapterJobs.find(
        (job: { id: string }) => job.id === jobId,
      ),
    ).toMatchObject({ id: jobId, localAiReceiptId: receiptId });
    expect(granted.records.localAiReceipts[0].grantedAt).toBeTruthy();
    expect(JSON.stringify(granted)).not.toContain(
      "Invented export receipt source",
    );
    await page.getByLabel(/Withdraw local AI permission for/).check();
    await page.getByRole("button", { name: "Withdraw permission" }).click();
    const withdrawn = await (
      await page.request.get("/api/member/export")
    ).json();
    expect(withdrawn.records.localAiReceipts).toMatchObject([
      { id: receiptId, evidenceId: source.id },
    ]);
    expect(withdrawn.records.localAiReceipts[0].withdrawnAt).toBeTruthy();
    expect(
      withdrawn.records.adapterJobs.find(
        (job: { id: string }) => job.id === jobId,
      ),
    ).toMatchObject({ id: jobId, localAiReceiptId: receiptId });
    const other = await otherPage.request.get("/api/member/export");
    expect(other.status()).toBe(200);
    expect((await other.json()).records.milestones).toEqual([]);
    expect((await other.json()).records.localAiReceipts).toEqual([]);
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [ownerId],
    );
    const revoked = await page.request.get("/api/member/export");
    expect(revoked.status()).toBe(403);
    expect(await revoked.json()).toEqual({ error: "forbidden" });
    await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
      ownerId,
    ]);
    await pool.query(
      "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
      [ownerId],
    );
    const deleting = await page.request.get("/api/member/export");
    expect(deleting.status()).toBe(403);
    expect(await deleting.json()).toEqual({ error: "forbidden" });
    await pool.query(
      "UPDATE workspaces SET deleting_at=NULL WHERE owner_principal_id=$1",
      [ownerId],
    );
    const recovered = await page.request.get("/api/member/export");
    expect(recovered.status()).toBe(200);
    expect((await recovered.json()).records.milestones).toMatchObject([
      { milestoneTitle: "Owner-only milestone" },
    ]);
    await pool.query(
      "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
      [ownerId],
    );
    const expired = await page.request.get("/api/member/export");
    expect(expired.status()).toBe(403);
    expect(await expired.json()).toEqual({ error: "forbidden" });
  } finally {
    await otherContext.close();
  }
});

test("[L67] deterministic member jobs export only to their owner and disappear with the local account", async ({
  page,
  context,
  browser,
}) => {
  const otherContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  try {
    const other = await otherContext.newPage();
    await onboard(page);
    await onboard(other);
    const ownerId = await memberId(context);
    const cookie = (await context.cookies()).find(
      (item) => item.name === "dne_preview",
    );
    expect(cookie).toBeDefined();
    const jobs = jobStore(pool);
    const marker = randomUUID();
    const owned = await jobs.enqueueForMember(
      cookie!.value,
      "email",
      "test",
      "synthetic-notice",
      `member-${marker}`,
      requestFingerprint({ invented: marker }),
    );
    const system = await jobs.enqueue(
      "analytics",
      "test",
      "record",
      `system-${marker}`,
      requestFingerprint({ system: marker }),
    );
    const own = await (await page.request.get("/api/member/export")).json();
    expect(own.version).toBe("local-member-records-v15");
    expect(own.records.adapterJobs).toMatchObject([
      {
        id: owned.id,
        adapter: "email",
        mode: "test",
        status: "pending",
        localAiReceiptId: null,
      },
    ]);
    expect(JSON.stringify(own)).not.toContain(`member-${marker}`);
    const elsewhere = await (
      await other.request.get("/api/member/export")
    ).json();
    expect(elsewhere.records.adapterJobs).toEqual([]);
    await page.goto("/learn");
    await page.getByLabel("Delete my local preview").check();
    await page.getByRole("button", { name: "Delete this preview" }).click();
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM adapter_jobs WHERE member_id=$1",
          [ownerId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await jobs.find(system.id)).toMatchObject({ id: system.id });
    const remaining = await (
      await other.request.get("/api/member/export")
    ).json();
    expect(remaining.profile.id).toBe(await memberId(otherContext));
  } finally {
    await otherContext.close();
  }
});

test("[L90] owner downloads every bounded live page with safe continuation and current authorization", async ({
  page,
  context,
  browser,
}) => {
  const otherContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  try {
    await onboard(page);
    const other = await otherContext.newPage();
    await onboard(other);
    const ownerId = await memberId(context);
    const ids: string[] = [];
    for (let index = 0; index < 120; index++) {
      const id = `10000000-${randomUUID().slice(9)}`;
      ids.push(id);
      await pool.query(
        `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
        VALUES($1,$2,'Invented page proposal',$3,'Original',clock_timestamp())`,
        [id, ownerId, 'é\\"'.repeat(1000)],
      );
    }
    await page
      .getByRole("link", { name: "Download my structured preview records" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Download private preview records",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(/Each page is a live read, not one frozen snapshot/),
    ).toBeVisible();
    // A record arriving after the HTML preview changes the byte cut. Only
    // continuation from the downloaded response can preserve the displaced row.
    await expect(
      page.getByRole("link", { name: "Next page", exact: true }),
    ).toHaveCount(0);
    const inserted = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    ids.push(inserted);
    await pool.query(
      `INSERT INTO member_proposals(id,member_id,title,body,sources,sample_attested_at)
       SELECT $1,$2,'Invented intervening proposal',body,'Original',clock_timestamp()
       FROM member_proposals WHERE member_id=$2 LIMIT 1`,
      [inserted, ownerId],
    );
    const found: string[] = [];
    let count = 0;
    let savedContinuation = "";
    while (true) {
      count++;
      expect(count).toBeLessThan(10);
      const link = page.getByRole("button", {
        name: `Download page ${count}`,
        exact: true,
      });
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        link.click(),
      ]);
      expect(download.suggestedFilename()).toBe(
        `deep-native-member-records-page-${count}.json`,
      );
      const bytes = await readFile((await download.path())!);
      expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
      const payload = JSON.parse(bytes.toString("utf8"));
      expect(payload.page).toMatchObject({
        number: count,
        consistency: "live-pages",
      });
      expect(payload.page.recordCount).toBeLessThanOrEqual(100);
      expect(payload.page.recordCount).toBeGreaterThan(0);
      found.push(
        ...payload.records.proposals.map((row: { id: string }) => row.id),
      );
      const next = page.getByRole("link", { name: "Next page", exact: true });
      if (payload.page.complete) {
        expect(payload.page.nextCursor).toBeNull();
        await expect(next).toHaveCount(0);
        break;
      }
      expect(payload.page.nextCursor).toBeTruthy();
      const nextHref = (await next.getAttribute("href"))!;
      savedContinuation = nextHref;
      const denied = await other.request.get(
        nextHref.replace("/member/export", "/api/member/export"),
      );
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden" });
      await next.focus();
      await expect(next).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: `Page ${count + 1}`, exact: true }),
      ).toBeVisible();
    }
    expect(count).toBeGreaterThan(1);
    expect(found).toEqual(ids.sort());
    expect(new Set(found).size).toBe(121);
    await expect(page.getByText(/End of this live traversal/)).toBeVisible();
    expect((await page.request.get(`${savedContinuation}x`)).status()).toBe(
      403,
    );
    await pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [ownerId],
    );
    await page
      .getByRole("button", { name: `Download page ${count}`, exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "This page was not downloaded",
    );
    await expect(
      page.getByRole("link", { name: "Next page", exact: true }),
    ).toHaveCount(0);
    const revoked = await page.goto(savedContinuation);
    expect(revoked!.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Export unavailable", exact: true }),
    ).toBeVisible();
    expect(
      (
        await page.request.get(
          savedContinuation.replace("/member/export", "/api/member/export"),
        )
      ).status(),
    ).toBe(403);
  } finally {
    await otherContext.close();
  }
});
