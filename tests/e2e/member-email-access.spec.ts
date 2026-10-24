import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";

const pool = testPool();
const members = store(pool);
test.beforeAll(async () => {
  await migrate(pool);
});
test.afterAll(async () => {
  await pool.end();
});

test("[L213] email verification restores the exact saved member in another browser", async ({
  page,
  browser,
}) => {
  const token = randomBytes(32).toString("hex");
  const emailAddress = `member-${token.slice(0, 12)}@example.com`;
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw Error("Synthetic member was not created");
  await members.save(session.learner.id, {
    instruction: "My invented learning plan has three careful steps.",
    verification: "I will compare each invented detail with the source.",
    complete: true,
  });
  let origin = "http://127.0.0.1:0";
  const messages: { address: string; link: string }[] = [];
  const email = memberEmailAccess(
    pool,
    {
      async send(address, link) {
        messages.push({
          address,
          link: link.replace("http://127.0.0.1:0", origin),
        });
      },
    },
    origin,
  );
  const settings = {
    get origin() {
      return origin;
    },
    secret: "synthetic-browser-email-secret",
    memberEmail: email,
  };
  const server = await listenLoopback(app(members, settings));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Loopback address unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  let returning;
  try {
    await page
      .context()
      .addCookies([{ name: "dne_preview", value: token, url: origin }]);
    await page.goto(`${origin}/learn`);
    await expect(page.getByText("1 / 1")).toBeVisible();
    await page
      .getByRole("link", {
        name: "Link email to keep access to this learning record",
      })
      .click();
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.address).toBe(emailAddress);
    returning = await browser.newContext();
    const fresh = await returning.newPage();
    await fresh.goto(messages[0]!.link);
    await expect(
      fresh.getByRole("heading", { name: "Confirm email link" }),
    ).toBeVisible();
    await fresh.getByRole("button", { name: "Continue" }).click();
    await expect(
      fresh.getByRole("heading", { name: "Email linked" }),
    ).toBeVisible();
    await fresh.goto(`${origin}/email/sign-in`);
    await fresh.getByLabel("Email address").fill(emailAddress);
    await fresh.getByRole("button", { name: "Send sign-in link" }).click();
    expect(messages).toHaveLength(2);
    await fresh.goto(messages[1]!.link);
    await fresh.getByRole("button", { name: "Continue" }).click();
    await expect(fresh).toHaveURL(`${origin}/learn`);
    await expect(fresh.getByText("1 / 1")).toBeVisible();
    await fresh.getByRole("link", { name: "Review your work" }).click();
    await expect(
      fresh.getByText("My invented learning plan has three careful steps."),
    ).toBeVisible();
    expect((await members.session(token)).kind).not.toBe("active");
  } finally {
    await returning?.close();
    await closeLoopback(server);
  }
});
