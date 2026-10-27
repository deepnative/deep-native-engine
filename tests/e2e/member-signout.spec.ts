import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { migrate, store } from "../../src/store.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";

const root = new URL(
  process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({ connectionString: root.toString() });
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({ connectionString: scoped.toString() });
const members = store(pool);
test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
});
test.afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});
async function fixture(
  page: Page,
  mode: "normal" | "disabled" | "before-commit" | "lost-commit" = "normal",
  linked = true,
) {
  const token = randomBytes(32).toString("hex"),
    address = `signout-${token.slice(0, 12)}@example.com`;
  await members.create(token, { background: "professional", goal: "work" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  await members.save(session.learner.id, {
    instruction: "My invented sign-out learning plan",
    verification: "Check the invented source",
    complete: true,
  });
  let origin = "http://127.0.0.1:0",
    mutations = 0;
  const messages: string[] = [];
  const sender = {
    async send(_address: string, link: string) {
      messages.push(link.replace("http://127.0.0.1:0", origin));
    },
  };
  const access = memberEmailAccess(pool, sender, origin);
  if (linked) {
    await access.requestAttach(token, address);
    await access.consume(
      new URL(messages.at(-1)!).searchParams.get("code")!,
      token,
    );
  }
  const boundary = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith("UPDATE principals SET token_hash")) mutations++;
          if (mode === "before-commit" && sql.startsWith("UPDATE learners"))
            throw Error("Synthetic write failure");
          const result = await client.query(sql, values);
          if (mode === "lost-commit" && sql === "COMMIT")
            throw Error("Synthetic lost commit acknowledgement");
          return result;
        },
        release: (error?: Error) => client.release(error),
      };
    },
  } as unknown as Pool;
  const signout = memberEmailAccess(boundary, sender, origin);
  const server = await listenLoopback(
    app(members, {
      get origin() {
        return origin;
      },
      secret: "synthetic-signout-browser",
      memberEmail:
        mode === "disabled"
          ? undefined
          : { ...access, signOut: signout.signOut },
    }),
  );
  const binding = server.address();
  if (!binding || typeof binding === "string")
    throw Error("Loopback unavailable");
  origin = `http://127.0.0.1:${binding.port}`;
  await page
    .context()
    .addCookies([{ name: "dne_preview", value: token, url: origin }]);
  return {
    origin,
    token,
    address,
    id: session.learner.id,
    messages,
    access,
    mutations: () => mutations,
    close: () => closeLoopback(server),
  };
}
async function returnByEmail(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await page.goto(`${f.origin}/email/sign-in`);
  await page.getByLabel("Email address").fill(f.address);
  const before = f.messages.length;
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect.poll(() => f.messages.length).toBe(before + 1);
  await page.goto(f.messages.at(-1)!);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(`${f.origin}/learn`);
  await expect(page.getByText("1 / 1")).toBeVisible();
  await page.getByRole("link", { name: "My account", exact: true }).click();
  await expect(page.getByLabel("Your starting point")).toHaveValue(
    "professional",
  );
  const next = (await page.context().cookies()).find(
    (c) => c.name === "dne_preview",
  )!.value;
  expect(await members.session(next)).toMatchObject({
    kind: "active",
    learner: { id: f.id },
  });
}

test("[L230] MOUT-01/02 a linked member signs out and deliberately returns by email to the same saved work", async ({
  page,
  browser,
}) => {
  const f = await fixture(page),
    copied = await browser.newContext();
  try {
    await copied.addCookies([
      { name: "dne_preview", value: f.token, url: f.origin },
    ]);
    await page
      .context()
      .addCookies([
        { name: "dne_staff", value: "c".repeat(64), url: f.origin },
      ]);
    await page.goto(`${f.origin}/account`);
    await expect(
      page.getByText("including any copied browser cookies", { exact: false }),
    ).toBeVisible();
    const sends = f.messages.length;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Signed out", exact: true }),
    ).toBeVisible();
    expect(f.messages).toHaveLength(sends);
    expect(
      (await page.context().cookies()).find((c) => c.name === "dne_preview"),
    ).toBeUndefined();
    expect(
      (await page.context().cookies()).find((c) => c.name === "dne_staff")
        ?.value,
    ).toBe("c".repeat(64));
    const stale = await copied.newPage();
    await stale.goto(`${f.origin}/account`);
    await expect(stale).toHaveURL(`${f.origin}/`);
    await page.screenshot({
      path: `artifacts/member-signout-${test.info().project.name}.png`,
      fullPage: true,
    });
    await returnByEmail(page, f);
    expect((await members.session(f.token)).kind).not.toBe("active");
    expect(await members.progress(f.id)).toMatchObject({
      instruction: "My invented sign-out learning plan",
    });
  } finally {
    await copied.close();
    await f.close();
  }
});

test("[L231] MOUT-03 browser-only, pending and unavailable recovery retain access and explain the next step", async ({
  page,
}) => {
  const f = await fixture(page, "normal", false);
  try {
    for (const pending of [false, true]) {
      if (pending) await f.access.requestAttach(f.token, f.address);
      await page.goto(`${f.origin}/account`);
      await expect(
        page.getByRole("heading", { name: "This browser only" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign out", exact: true }),
      ).toHaveCount(0);
      const csrf = await page
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
      const denied = await page.request.post(`${f.origin}/account/sign-out`, {
        headers: { Origin: f.origin },
        form: { csrf },
      });
      expect(denied.status()).toBe(409);
      expect(await denied.text()).toContain("Link and verify");
      expect((await members.session(f.token)).kind).toBe("active");
    }
  } finally {
    await f.close();
  }
  const stale = await fixture(page);
  try {
    await page.goto(`${stale.origin}/account`);
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await pool.query(
      "DELETE FROM member_email_identities WHERE principal_id=$1",
      [stale.id],
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign-out unavailable", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Link and verify an email before signing out.", {
        exact: false,
      }),
    ).toBeVisible();
    expect((await members.session(stale.token)).kind).toBe("active");
  } finally {
    await stale.close();
  }
  const disabled = await fixture(page, "disabled");
  try {
    await page.goto(`${disabled.origin}/account`);
    await expect(
      page.getByRole("heading", { name: "Email recovery is unavailable" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign out", exact: true }),
    ).toHaveCount(0);
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    expect(
      (
        await page.request.post(`${disabled.origin}/account/sign-out`, {
          headers: { Origin: disabled.origin },
          form: { csrf },
        })
      ).status(),
    ).toBe(503);
    expect((await members.session(disabled.token)).kind).toBe("active");
    expect(await members.progress(disabled.id)).toMatchObject({
      instruction: "My invented sign-out learning plan",
    });
  } finally {
    await disabled.close();
  }
});

test("[L232] MOUT-06 failed and lost-commit signout shows uncertainty without replay and email return recovers the same work", async ({
  page,
}) => {
  for (const failure of ["before-commit", "lost-commit"] as const) {
    const f = await fixture(page, failure);
    try {
      await page.goto(`${f.origin}/account`);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Sign-out could not be confirmed" }),
      ).toBeVisible();
      await expect(
        page.getByText("Do not resend this form", { exact: false }),
      ).toBeVisible();
      expect(f.mutations()).toBe(1);
      expect(
        (await page.context().cookies()).find((c) => c.name === "dne_preview")
          ?.value,
      ).toBe(f.token);
      expect((await members.session(f.token)).kind === "active").toBe(
        failure === "before-commit",
      );
      await page.getByRole("link", { name: "Check My account" }).click();
      await expect(page).toHaveURL(
        failure === "before-commit" ? `${f.origin}/account` : `${f.origin}/`,
      );
      await returnByEmail(page, f);
      expect(f.mutations()).toBe(1);
      expect(await members.progress(f.id)).toMatchObject({
        instruction: "My invented sign-out learning plan",
      });
    } finally {
      await f.close();
    }
  }
});
