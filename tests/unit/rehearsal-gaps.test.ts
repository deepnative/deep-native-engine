import express from "express";
import request from "supertest";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountAdministratorEntry } from "../../src/administrator-entry-routes.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import { accountPage, dashboard, lesson } from "../../src/views.ts";

const sources = () =>
  readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join("src", name));

describe("#698 make dev runs source under Node type stripping", () => {
  it("DEVSTART-01 every source file is accepted in strip-only mode", () => {
    const refused = sources().filter((file) => {
      try {
        stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
  });
  it("DEVSTART-02 typecheck refuses syntax that type stripping cannot run", () => {
    const config = JSON.parse(readFileSync("tsconfig.json", "utf8")) as {
      compilerOptions: { erasableSyntaxOnly?: boolean };
    };
    expect(config.compilerOptions.erasableSyntaxOnly).toBe(true);
  });
});

const learner = {
  id: "invented",
  background: "explorer",
  goal: "everyday",
} as const;
const csrf = "c".repeat(64);

describe("#44 rehearsal: account and assignment pages", () => {
  it.each([
    [false, "Download private preview records"],
    [true, "Download my private records"],
  ])(
    "ACCOUNT-EXPORT-01 My account links to export (hosted %s)",
    (hosted, label) => {
      const html = withHosting(hosted, () =>
        accountPage(learner, csrf, "unlinked"),
      );
      expect(html).toContain(`href="/member/export">${label}</a>`);
    },
  );
  it("ASSIGN-PREREQ-01 says what a stored None prerequisite means", () => {
    const html = dashboard(learner, undefined, csrf, [], [
      {
        id: "DEMO-544",
        version: 1,
        kind: "assignment",
        title: "Invented assignment",
        prerequisites: "None",
      },
    ] as never);
    expect(html).toContain("<p>No prerequisite</p>");
    expect(html).not.toContain("<p>None</p>");
  });
});

describe("#699 wording that ignores accounts", () => {
  const saved = () =>
    lesson(learner, { goal_at_start: "everyday" } as never, csrf);
  it("WORDING-01 a saved lesson draft is not tied to this browser when hosted", () => {
    expect(withHosting(false, saved)).toContain(
      "Your draft is saved. You can return in this browser.",
    );
    const hosted = withHosting(true, saved);
    expect(hosted).toContain(
      "Your draft is saved. You can return to it from any device after you sign in.",
    );
    expect(hosted).not.toContain("in this browser");
  });
  it("WORDING-02 tells a signed-in owner how to verify, not to sign in again", async () => {
    const denied = async (hosted: boolean) => {
      const site = express();
      site.use((_req, _res, next) => withHosting(hosted, next));
      mountAdministratorEntry(site, undefined, {
        origin: "http://127.0.0.1:3000",
        secret: "s",
        localStaffEntry: false,
      });
      return (await request(site).get("/operator")).text;
    };
    const hosted = await denied(true);
    expect(hosted).toContain("open the verification link we emailed you");
    expect(hosted).toContain("send a new one from My account");
    expect(hosted).not.toContain("already verified owner email");
    expect(await denied(false)).toContain("already verified owner email");
  });
});
