import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  adapterReadiness,
  deterministicRegistry,
  type AdapterRegistry,
} from "../../src/adapters.ts";
import { app } from "../../src/app.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
import {
  aiMember,
  aiOrigin,
  aiStorage,
  grantStudyRequests,
  memberJobs,
  permitSample,
  savedForm,
  savedSample,
  signIn,
  studyBalance,
  withdrawPermission,
} from "../support/local-ai-journey.ts";
import { closeLoopback } from "../support/loopback-server.ts";
import { requiredCheck } from "../support/required-check.ts";

const pool = testPool();
test.afterAll(async () => pool.end());

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("[F-ROADMAP-05-A] opting out dispatches nothing, the demo says it is simulated and live AI stays off without a provider", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const member = await aiMember(pool);
  try {
    const grantId = await grantStudyRequests(pool, member.id, 1);
    await signIn(page, member.token);
    let completedJobs = 0;

    await requiredCheck(1, async () => {
      // A sample with no permission offers no way to start a job.
      const unpermitted = await savedSample(pool, page);
      await expect(
        unpermitted.item.getByRole("button", {
          name: "Queue local simulation",
        }),
      ).toHaveCount(0);

      // Withdrawing permission is the opt-out. Saved forms must not outlive it.
      const permitted = await permitSample(pool, page);
      const plain = await savedForm(permitted.item, "/queue");
      const metered = await savedForm(permitted.item, "/queue-metered");
      await withdrawPermission(permitted.item);
      await expect(
        permitted.item.getByRole("button", { name: "Queue local simulation" }),
      ).toHaveCount(0);
      for (const form of [plain, metered]) {
        const replay = await page.request.post(form.action, {
          headers: { Origin: aiOrigin },
          form: form.fields,
          maxRedirects: 0,
        });
        expect(replay.status()).toBe(403);
      }
      const forged = await page.request.post(
        `/evidence/local-ai/${randomUUID()}/queue`,
        {
          headers: { Origin: aiOrigin },
          form: plain.fields,
          maxRedirects: 0,
        },
      );
      expect(forged.status()).toBe(403);

      expect(await memberJobs(pool, member.id)).toEqual([]);
      expect(await studyBalance(pool, grantId)).toEqual({
        available: 1,
        reserved: 0,
        consumed: 0,
      });
    });

    await requiredCheck(2, async () => {
      const permitted = await permitSample(pool, page);
      await permitted.item
        .getByRole("button", { name: "Queue local simulation" })
        .click();
      await permitted.item
        .getByRole("button", { name: "Run local simulation" })
        .click();
      await expect(permitted.item).toContainText(
        "Simulated locally. No provider request or qualified review occurred.",
      );
      await expect(page.locator(".eyebrow").first()).toContainText(
        "SIMULATION",
      );
      completedJobs = 1;
      expect(await memberJobs(pool, member.id)).toEqual([
        {
          id: expect.any(String),
          mode: "test",
          adapter: "ai",
          status: "succeeded",
        },
      ]);
      // Choosing the plain simulation spends nothing.
      expect(await studyBalance(pool, grantId)).toEqual({
        available: 1,
        reserved: 0,
        consumed: 0,
      });
      await page.goto("/readiness");
      await expect(
        page.getByRole("listitem").filter({ hasText: "Simulated. No request" }),
      ).toContainText("Simulated. No request goes to an AI provider.");
    });

    await requiredCheck(3, async () => {
      // A sample the member has permitted right now on the ordinary site: its
      // two queue forms are what a live-mode attempt has to be refused.
      const open = await permitSample(pool, page);
      const openForms = [
        await savedForm(open.item, "/queue"),
        await savedForm(open.item, "/queue-metered"),
      ];
      // Hosting refuses live mode outright, so this listener runs the same
      // application in live mode with no provider settings at all.
      const port = await freePort();
      const liveOrigin = `http://127.0.0.1:${port}`;
      const live = app(store(pool), {
        origin: liveOrigin,
        secret: randomBytes(32).toString("hex"),
        mode: "live",
        adapters: adapterReadiness({}, "live"),
        localAiConsent: localAiConsentStore(pool, aiStorage(), {
          ...deterministicRegistry({}, "test"),
          mode: "live",
        } as unknown as AdapterRegistry),
      }).listen(port, "127.0.0.1");
      await new Promise((resolve) => live.once("listening", resolve));
      const liveContext = await page.context().browser()!.newContext({
        baseURL: liveOrigin,
      });
      try {
        const livePage = await liveContext.newPage();
        await signIn(livePage, member.token, liveOrigin);
        await livePage.goto("/readiness");
        await expect(
          livePage.getByRole("listitem").filter({ hasText: /^AI · / }),
        ).toContainText("AI · Off");
        await expect(
          livePage.getByRole("listitem").filter({ hasText: /^AI · / }),
        ).toContainText("Turned off. This service is not connected here.");
        expect(
          (await livePage.request.get("/operator/local-ai")).status(),
        ).toBe(404);
        await livePage.goto("/evidence/local-ai");
        for (const name of [
          "Queue local simulation",
          "Grant local simulation permission",
          "Use one local test request",
        ])
          await expect(livePage.getByRole("button", { name })).toHaveCount(0);
        await expect(livePage.getByRole("status")).toContainText(
          "Local simulations are unavailable.",
        );
        // This page offers no form at all, so take a token from the evidence page.
        await livePage.goto("/evidence");
        const csrf = await livePage
          .locator('input[name="csrf"]')
          .first()
          .inputValue();
        const attempt = await livePage.request.post(
          `/evidence/local-ai/${randomUUID()}/queue`,
          {
            headers: { Origin: liveOrigin },
            form: { csrf },
            maxRedirects: 0,
          },
        );
        expect(attempt.status()).toBe(403);
        // The permitted receipt itself is refused in live mode, plain and
        // metered, and nothing is queued or held.
        for (const form of openForms) {
          const refused = await livePage.request.post(
            new URL(form.action, liveOrigin).pathname,
            {
              headers: { Origin: liveOrigin },
              form: { ...form.fields, csrf },
              maxRedirects: 0,
            },
          );
          expect(refused.status(), form.action).toBe(403);
          // Refused by the simulation route itself, not as a stale form.
          expect(await refused.text()).not.toContain(
            "Your form needs a refresh",
          );
        }
        expect(await memberJobs(pool, member.id)).toHaveLength(completedJobs);
        expect(await studyBalance(pool, grantId)).toEqual({
          available: 1,
          reserved: 0,
          consumed: 0,
        });
      } finally {
        await liveContext.close();
        await closeLoopback(live);
      }

      // The ordinary site is untouched: the same receipt that live mode
      // refused still queues and runs there, as a simulation.
      await page.goto("/evidence/local-ai");
      await open.item
        .getByRole("button", { name: "Queue local simulation" })
        .click();
      await open.item
        .getByRole("button", { name: "Run local simulation" })
        .click();
      await expect(open.item).toContainText("Simulated locally.");
      const jobs = await memberJobs(pool, member.id);
      expect(jobs).toHaveLength(completedJobs + 1);
      expect(jobs.every((job) => job.mode === "test")).toBe(true);
    });
  } finally {
    await pool.query("DELETE FROM principals WHERE id=$1", [member.id]);
  }
});
