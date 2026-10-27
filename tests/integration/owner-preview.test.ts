import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { Client, Pool, type PoolClient, type QueryResult } from "pg";
import { tmpdir } from "node:os";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, expect, it, vi } from "vitest";
import {
  cleanupDiagnostic,
  launchPreview,
} from "../../scripts/private-preview.mjs";
import { testPool } from "../support/database.ts";

// Lifecycle tests allow 150s for setup, the unchanged 20s zero-session wait,
// and one 90s administrative DROP (#546); member request limits are unchanged.
const control = testPool();
afterAll(() => control.end());
function previewEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DNE_")),
  );
  return { ...env, DNE_PREVIEW_CONTROL_URL: process.env.DNE_TEST_DATABASE_URL };
}
function start(controlUrl = process.env.DNE_TEST_DATABASE_URL) {
  const child = spawn(process.execPath, ["scripts/private-preview.mjs"], {
    env: { ...previewEnvironment(), DNE_PREVIEW_CONTROL_URL: controlUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.stderr!.on("data", (bytes) => {
    stderr += String(bytes);
  });
  const ready = new Promise<{
    origin: string;
    revision: string;
    tree: string;
    workingTreeModified: boolean;
    staffSetupFile: string;
  }>((resolve, reject) => {
    child.stdout!.on("data", (bytes) => {
      stdout += String(bytes);
      if (stdout.includes("\n")) {
        try {
          resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n"))));
        } catch {
          reject(new Error("Preview did not emit a safe startup record"));
        }
      }
    });
    child.once("exit", () =>
      reject(
        new Error(
          "Preview exited before ready; inspect retained test diagnostics",
        ),
      ),
    );
    child.once("error", reject);
  });
  return { child, ready, exited, output: () => stdout + stderr };
}
async function staffSession(origin: string, credential: string) {
  const form = await fetch(origin + "/staff/sign-in");
  const entry = form.headers
    .getSetCookie()
    .find((value) => value.startsWith("dne_staff_entry="))!
    .split(";")[0]!;
  const csrf = (await form.text()).match(
    /name="csrf" value="([a-f0-9]+)"/,
  )![1]!;
  const signedIn = await fetch(origin + "/staff/sign-in", {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: entry,
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf, credential }),
  });
  expect(signedIn.status).toBe(303);
  const staff = signedIn.headers
    .getSetCookie()
    .find((value) => value.startsWith("dne_staff="))!
    .split(";")[0]!;
  return async (path: string) => {
    const response = await fetch(origin + path, {
      headers: { Cookie: staff },
      redirect: "manual",
    });
    return { status: response.status, text: await response.text() };
  };
}
async function stop(child: ChildProcess, exited: Promise<number | null>) {
  child.kill("SIGTERM");
  return exited;
}
// A minimal form-submitting browser for one actor: it keeps its own cookies,
// sends the hidden fields the page actually rendered and never follows redirects.
function browserFor(origin: string) {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = pair!.indexOf("=");
      // A cleared cookie (empty or Max-Age=0) is removed as a browser would.
      if (at + 1 === pair!.length || /;\s*max-age=0/i.test(cookie))
        jar.delete(pair!.slice(0, at));
      else jar.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
  };
  const cookie = () =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  async function open(path: string) {
    const response = await fetch(origin + path, {
      headers: { Cookie: cookie() },
      redirect: "manual",
    });
    keep(response);
    return {
      status: response.status,
      location: response.headers.get("location"),
      text: await response.text(),
    };
  }
  async function submit(
    html: string,
    action: string,
    fields: Record<string, string> = {},
  ) {
    const start = html.indexOf(`action="${action}"`);
    expect(start, `form ${action}`).toBeGreaterThan(-1);
    const form = html.slice(start, html.indexOf("</form>", start));
    const hidden = Object.fromEntries(
      [
        ...form.matchAll(
          /<input type="hidden" name="([A-Za-z_]+)" value="([^"]*)">/g,
        ),
      ].map((match) => [
        match[1]!,
        match[2]!
          .replaceAll("&quot;", '"')
          .replaceAll("&#39;", "'")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      ]),
    );
    const response = await fetch(origin + action, {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie(),
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ...hidden, ...fields }),
    });
    keep(response);
    return {
      status: response.status,
      location: response.headers.get("location"),
      text: await response.text(),
    };
  }
  async function signIn(credential: string) {
    const form = await open("/staff/sign-in");
    const signed = await submit(form.text, "/staff/sign-in", { credential });
    expect(signed.status).toBe(303);
  }
  return { open, submit, signIn };
}

it("PREVIEW-01/02 PART-01/02/05/06 ASSIGN-PREVIEW-01/02/03 STUDY-PREVIEW-01/02/03 starts isolated fixtures and normal private learner journeys, then removes only owned resources", async () => {
  const before = (await control.query("SELECT current_database() AS name"))
    .rows[0].name;
  const proc = start();
  let db: Pool | undefined;
  try {
    const ready = await proc.ready;
    expect(ready.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(ready.origin).port).not.toBe("4317");
    expect(ready.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(ready.tree).toMatch(/^[a-f0-9]{40}$/);
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    expect((await stat(ready.staffSetupFile)).mode & 0o777).toBe(0o600);
    expect((await stat(metadata.privateRoot)).mode & 0o777).toBe(0o700);
    const own = new URL(metadata.database).pathname.slice(1);
    expect(own).toMatch(/^dne_test_[a-f0-9]{32}$/);
    expect(own).not.toBe(before);
    db = new Pool({ connectionString: metadata.database });
    expect(
      (await db.query("SELECT count(*)::int n FROM learners")).rows[0].n,
    ).toBe(0);
    expect(
      (await db.query("SELECT count(*)::int n FROM evidence_objects")).rows[0]
        .n,
    ).toBe(0);
    expect(
      (await db.query("SELECT count(*)::int n FROM assignment_grants")).rows[0]
        .n,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM evidence_review_submissions",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT role FROM staff_profiles ORDER BY role")
      ).rows.map((r) => r.role),
    ).toEqual([
      "editor",
      "moderator",
      "operator",
      "platform_admin",
      "reviewer",
    ]);
    expect(metadata.moderatorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.moderatorCredential).toMatch(/^[a-f0-9]{64}$/);
    // PART-01: participation tools are enabled, but no activity is seeded.
    for (const table of [
      "preview_circle_memberships",
      "preview_circle_choices",
      "preview_circle_posts",
      "preview_circle_reports",
      "preview_circle_moderator_grants",
      "member_proposals",
      "private_event_rehearsals",
      "private_event_enrollments",
      "private_event_cancellations",
      "private_event_attendance_permissions",
      "browser_study_fixture_requests",
      "synthetic_entitlement_grants",
      "local_ai_receipts",
      "adapter_jobs",
    ])
      expect(
        (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT id,state,requires_qualified_signoff FROM content_versions WHERE state='published' ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { id: "DEMO-509", state: "published", requires_qualified_signoff: false },
      { id: "DEMO-544", state: "published", requires_qualified_signoff: false },
    ]);
    expect(
      (
        await db.query(
          "SELECT bool_and(state='draft') AS untouched FROM content_versions WHERE requires_qualified_signoff",
        )
      ).rows[0].untouched,
    ).toBe(true);
    const response = await fetch(ready.origin);
    expect(response.status).toBe(200);
    const welcome = await response.text();
    expect(welcome).toContain("Start my learning path");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = welcome.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;
    const onboarded = await fetch(ready.origin + "/start", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: ready.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf,
        background: "explorer",
        goal: "everyday",
        synthetic: "yes",
      }),
    });
    expect(onboarded.status).toBe(303);
    const memberPage = await fetch(ready.origin + "/learn", {
      headers: { Cookie: cookie },
    });
    expect(memberPage.status).toBe(200);
    expect(await memberPage.text()).toContain(
      "Invented preview: clarify a sample request",
    );
    // STUDY-PREVIEW-01: the opt-in launcher makes the existing request usable.
    const studyRequest = await fetch(
      ready.origin + "/member/test-unit-request",
      { headers: { Cookie: cookie } },
    );
    expect(studyRequest.status).toBe(200);
    expect(await studyRequest.text()).toContain('name="administratorId"');
    const samples = await fetch(ready.origin + "/evidence", {
      headers: { Cookie: cookie },
    });
    expect(await samples.text()).toContain("Use a prepared invented sample");
    expect(
      (await db.query("SELECT count(*)::int n FROM learners")).rows[0].n,
    ).toBe(1);
    // ASSIGN-PREVIEW-01: a fresh preview supplies catalog choices, not activity.
    for (const table of ["learner_assignment_choices", "assignment_attempts"])
      expect(
        (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    const assignmentTitle = "Invented preview: check a sample plan";
    const privateResponse =
      "I will compare an invented two-hour plan with the sample constraints.";
    const issuer = browserFor(ready.origin);
    await issuer.signIn(metadata.administratorCredential);
    const issuerPage = await issuer.open("/operator/study-test-units");
    expect(issuerPage.status).toBe(200);
    expect(issuerPage.text).not.toContain(
      "New requests and issuance are paused",
    );
    const administratorReference = issuerPage.text.match(
      /<code>([0-9a-f-]{36})<\/code>/,
    )![1]!;
    const studyBalances = (html: string) =>
      html.match(
        /<section data-test-unit-category="study_requests">([\s\S]*?)<\/section>/,
      )![1]!;
    for (const background of ["technical", "professional", "explorer"]) {
      const actor = browserFor(ready.origin);
      const entry = await actor.open("/");
      expect(
        (
          await actor.submit(entry.text, "/start", {
            background,
            goal: "everyday",
            synthetic: "yes",
          })
        ).status,
      ).toBe(303);
      const learning = await actor.open("/learn");
      expect(learning.status).toBe(200);
      expect(learning.text).toContain(`Choose ${assignmentTitle}</button>`);
      const chosen = await actor.submit(learning.text, "/assignments/select", {
        content_id: "DEMO-544",
        content_version: "1",
      });
      expect(chosen.status).toBe(303);
      const selected = await actor.open("/learn");
      expect(selected.text).toContain(
        "Start or return to this private attempt",
      );
      // ASSIGN-PREVIEW-02: only ordinary deliberate forms create and save work.
      const started = await actor.submit(
        selected.text,
        "/assignments/attempts/start",
        { content_id: "DEMO-544", content_version: "1" },
      );
      expect(started.status).toBe(303);
      expect(started.location).toMatch(
        /^\/assignments\/attempts\/[0-9a-f-]{36}$/,
      );
      const attempt = await actor.open(started.location!);
      expect(attempt.text).toContain("Assignment version 1");
      expect(attempt.text).toContain("started only");
      const saved = await actor.submit(
        attempt.text,
        started.location! + "/save",
        { response: privateResponse, sample_confirmed: "yes" },
      );
      expect(saved.status).toBe(303);
      const reloaded = await actor.open(started.location!);
      expect(reloaded.text).toContain(privateResponse);
      expect(reloaded.text).toContain("private draft saved");
      const history = await actor.open("/assignments/attempts");
      expect(history.text).toContain(assignmentTitle);
      expect(history.text).toContain("version 1");
      // ASSIGN-PREVIEW-03: the original learner cannot read another actor's work.
      const denied = await fetch(ready.origin + started.location!, {
        headers: { Cookie: cookie },
      });
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain(privateResponse);

      // STUDY-PREVIEW-02: use the existing finite fixture only through forms.
      const emptyBalance = await actor.open("/member/test-units");
      expect(studyBalances(emptyBalance.text)).toContain(
        'data-field="usable">0</span>',
      );
      const fixture = await actor.open("/member/test-unit-request");
      const checkedRequest = await actor.submit(
        fixture.text,
        "/member/test-unit-request/check",
        { administratorId: administratorReference },
      );
      expect(checkedRequest.status).toBe(200);
      const requested = await actor.submit(
        checkedRequest.text,
        "/member/test-unit-request/request",
        { confirm: "yes" },
      );
      expect(requested.status).toBe(200);
      const requestReference = requested.text.match(
        /<dt>Request reference<\/dt><dd>([0-9a-f-]{36})<\/dd>/,
      )![1]!;
      const checkedIssue = await issuer.submit(
        (await issuer.open("/operator/study-test-units")).text,
        "/operator/study-test-units/check",
        { requestId: requestReference },
      );
      expect(checkedIssue.status).toBe(200);
      expect(
        (
          await issuer.submit(
            checkedIssue.text,
            "/operator/study-test-units/issue",
            { confirm: "yes" },
          )
        ).status,
      ).toBe(200);
      const issued = await actor.open("/member/test-units");
      expect(studyBalances(issued.text)).toContain(
        'data-field="usable">3</span>',
      );

      // The fixed provided copy is already clean; no quarantine store or SQL
      // transition manufactures a source, permission, unit or job for this path.
      const prepared = await actor.open("/evidence/prepared");
      const template = prepared.text.match(
        /<article data-prepared-template="everyday-options">([\s\S]*?)<\/article>/,
      )![1]!;
      const copied = await actor.submit(template, "/evidence/prepared", {
        providedExample: "yes",
        privateReview: "yes",
      });
      expect(copied.status).toBe(200);
      const permission = await actor.open("/evidence/local-ai");
      const permissionAction = permission.text.match(
        /action="(\/evidence\/local-ai\/[0-9a-f-]{36}\/grant)"/,
      )![1]!;
      expect(
        (
          await actor.submit(permission.text, permissionAction, {
            confirm: "yes",
          })
        ).status,
      ).toBe(303);
      const permitted = await actor.open("/evidence/local-ai");
      const holdAction = permitted.text.match(
        /action="(\/evidence\/local-ai\/[0-9a-f-]{36}\/queue-metered)"/,
      )![1]!;
      expect(
        (await actor.submit(permitted.text, holdAction, { confirm: "yes" }))
          .status,
      ).toBe(303);
      const held = await actor.open("/evidence/local-ai");
      expect(held.text).toContain("One local test request: held.");
      const runAction = held.text.match(
        /action="(\/evidence\/local-ai\/[0-9a-f-]{36}\/run)"/,
      )![1]!;
      expect((await actor.submit(held.text, runAction)).status).toBe(303);
      const consumed = await actor.open("/evidence/local-ai");
      expect(consumed.text).toContain("One local test request: consumed.");
      const checkedWithdrawal = await actor.submit(
        (await actor.open("/member/test-unit-request")).text,
        "/member/test-unit-request/withdraw/check",
      );
      expect(checkedWithdrawal.status).toBe(200);
      expect(
        (
          await actor.submit(
            checkedWithdrawal.text,
            "/member/test-unit-request/withdraw",
            { confirm: "yes" },
          )
        ).status,
      ).toBe(200);
      const finalBalance = studyBalances(
        (await actor.open("/member/test-units")).text,
      );
      for (const [field, quantity] of [
        ["usable", 0],
        ["held", 0],
        ["consumed", 1],
        ["expired", 2],
      ])
        expect(finalBalance).toContain(
          `data-field="${field}">${quantity}</span>`,
        );
      // STUDY-PREVIEW-03: another member's normal receipt page discloses none.
      const otherFixture = await fetch(
        ready.origin + "/member/test-unit-request",
        { headers: { Cookie: cookie } },
      );
      expect(otherFixture.status).toBe(200);
      expect(await otherFixture.text()).not.toContain(requestReference);
    }
    // PART-02/05: member pages offer discussion and event rehearsal.
    const circles = await fetch(ready.origin + "/circles", {
      headers: { Cookie: cookie },
    });
    expect(await circles.text()).toContain(
      "Invented discussion is available only after a separate circle sharing choice.",
    );
    const events = await fetch(ready.origin + "/events?all=1", {
      headers: { Cookie: cookie },
    });
    expect(await events.text()).toContain(
      "Explicitly labelled local registration rehearsals use invented data only.",
    );
    expect(
      (await db.query("SELECT count(*)::int n FROM staff_profiles")).rows[0].n,
    ).toBe(5);
    // PART-03/04/05: normal staff entry opens enabled tools; no grant exists.
    const admin = await staffSession(
      ready.origin,
      metadata.administratorCredential,
    );
    const grants = await admin("/operator/circle-grants");
    expect(grants.status).toBe(200);
    expect(grants.text).toContain(metadata.administratorId);
    expect(grants.text).not.toContain("paused");
    expect((await admin("/operator/event-rehearsals")).text).toContain(
      "Check a proposed schedule before deliberately confirming it.",
    );
    expect((await admin("/operator/event-cancellations")).text).toContain(
      "Check an exact future opted-in event before confirming cancellation.",
    );
    const moderator = await staffSession(
      ready.origin,
      metadata.moderatorCredential,
    );
    const reference = await moderator("/moderate/circle-reference");
    expect(reference.status).toBe(200);
    expect(reference.text).toContain(metadata.moderatorId);
    expect((await moderator("/moderate/proposals")).status).toBe(200);
    // PART-06: the moderator has no circle grant and no administrator tools.
    expect(
      (await moderator("/moderate/circles/everyday-ai/reports")).status,
    ).toBe(403);
    expect((await moderator("/operator/circle-grants")).status).toBe(403);
    expect((await moderator("/operator/study-test-units")).status).toBe(403);
    expect(proc.output().includes(metadata.moderatorCredential)).toBe(false);
    expect((await fetch(ready.origin + "/runtime-private.json")).status).toBe(
      404,
    );
    expect(proc.output().includes(metadata.administratorCredential)).toBe(
      false,
    );
    expect(proc.output().includes(metadata.reviewerCredential)).toBe(false);
    expect(proc.output().includes(metadata.database)).toBe(false);
    await db.end();
    db = undefined;
    const shutdownExit = await stop(proc.child, proc.exited);
    let shutdownDiagnostic: unknown;
    if (shutdownExit !== 0) {
      try {
        shutdownDiagnostic = cleanupDiagnostic(
          JSON.parse(await readFile(ready.staffSetupFile, "utf8")),
        );
      } catch {
        shutdownDiagnostic = { record: "missing-or-unreadable" };
        // A directory/save failure may leave only the launcher's bounded
        // in-memory diagnostic. Never include its raw stderr or private path.
        const prefix = "Preview cleanup diagnostic: ";
        const line = proc
          .output()
          .split("\n")
          .filter((line) => line.startsWith(prefix))
          .at(-1);
        if (line) {
          try {
            const summary = JSON.parse(line.slice(prefix.length));
            shutdownDiagnostic = {
              source: "memory-console",
              ...cleanupDiagnostic({
                cleanupStage: summary.stage,
                cleanupKind:
                  summary.kind === "absent" ? undefined : summary.kind,
                cleanupCode:
                  summary.code === "absent" ? undefined : summary.code,
                cleanupElapsedMs: summary.elapsedMs,
              }),
            };
          } catch {
            /* The original nonzero exit remains a failure. */
          }
        }
      }
    }
    expect(shutdownExit, JSON.stringify(shutdownDiagnostic)).toBe(0);
    expect(existsSync(metadata.privateRoot)).toBe(false);
    expect(
      (
        await control.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname=$1",
          [own],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await control.query("SELECT current_database() AS name")).rows[0].name,
    ).toBe(before);
  } finally {
    await db?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
  }
}, 150000);

it("SUPPREVIEW-01/02/03/04 rehearses member support intake, exact administrator assignment, separate operator actions and revocation through ordinary forms", async () => {
  const proc = start();
  let db: Pool | undefined;
  try {
    const ready = await proc.ready;
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    db = new Pool({ connectionString: metadata.database });
    // SUPPREVIEW-01: one distinct finite operator; zero seeded support facts.
    expect(metadata.operatorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.operatorCredential).toMatch(/^[a-f0-9]{64}$/);
    expect(
      new Set([
        metadata.operatorId,
        metadata.administratorId,
        metadata.reviewerId,
        metadata.moderatorId,
      ]).size,
    ).toBe(4);
    expect(
      (
        await db.query(
          "SELECT role, expires_at=$1::timestamptz AS finite FROM staff_profiles JOIN principals ON principals.id=staff_profiles.principal_id WHERE principal_id=$2",
          [metadata.expiry, metadata.operatorId],
        )
      ).rows,
    ).toEqual([{ role: "operator", finite: true }]);
    const supportTables = [
      "support_requests",
      "support_request_events",
      "support_request_grants",
      "support_request_mutations",
      "support_request_notes",
      "support_request_replies",
      "support_access_grants",
      "support_time_units",
      "support_time_allocations",
      "support_time_entries",
      "support_time_grants",
    ];
    for (const table of supportTables)
      expect(
        (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    for (const secret of [metadata.operatorCredential, metadata.operatorId])
      expect(proc.output().includes(secret)).toBe(false);

    // SUPPREVIEW-02: a member sends a request through the normal form.
    const member = browserFor(ready.origin);
    const welcome = await member.open("/");
    expect(
      (
        await member.submit(welcome.text, "/start", {
          background: "professional",
          goal: "work",
          synthetic: "yes",
        })
      ).status,
    ).toBe(303);
    const intake = await member.open("/support/new");
    const sent = await member.submit(intake.text, "/support", {
      subject: "Invented preview support question",
      body: "PREVIEW-SUPPORT-PRIVATE-BODY",
      synthetic: "yes",
    });
    expect(sent.status).toBe(303);
    const requestId = sent.location!.split("/").at(-1)!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const receipt = await member.open(`/support/${requestId}`);
    expect(receipt.text).toContain(requestId);
    expect(receipt.text).toContain("No separate acknowledgement recorded");

    const operator = browserFor(ready.origin);
    await operator.signIn(metadata.operatorCredential);
    const operatorHome = await operator.open("/staff");
    expect(operatorHome.text).toContain("My local assignment ID");
    const reference = await operator.open("/operator/assignment-id");
    expect(reference.status).toBe(200);
    const staffId = reference.text.match(
      /data-assignment-id>([0-9a-f-]{36})</,
    )![1]!;
    expect(staffId).toBe(metadata.operatorId);
    // Having an identity grants nothing: no request appears before assignment.
    const unassigned = await operator.open("/operator/support");
    expect(unassigned.status).toBe(200);
    expect(unassigned.text).not.toContain("PREVIEW-SUPPORT-PRIVATE-BODY");
    expect(unassigned.text).not.toContain(requestId);
    expect((await operator.open("/operator/support-assignment")).status).toBe(
      403,
    );

    const admin = browserFor(ready.origin);
    await admin.signIn(metadata.administratorCredential);
    expect((await admin.open("/staff")).text).toContain(
      "Support request assignments",
    );
    const assignment = await admin.open("/operator/support-assignment");
    expect(assignment.status).toBe(200);
    const checked = await admin.submit(
      assignment.text,
      "/operator/support-assignment/check",
      { requestId, staffId },
    );
    expect(checked.status).toBe(200);
    expect(checked.text).toContain("Confirm support assignment");
    expect(checked.text).not.toContain("PREVIEW-SUPPORT-PRIVATE-BODY");
    // The administrator cannot assign the request to itself.
    expect(
      (
        await admin.submit(
          assignment.text,
          "/operator/support-assignment/check",
          { requestId, staffId: metadata.administratorId },
        )
      ).status,
    ).toBe(403);
    const assigned = await admin.submit(
      checked.text,
      "/operator/support-assignment/assign",
      {
        startsAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.parse(metadata.expiry) - 1000).toISOString(),
        confirm: "yes",
      },
    );
    expect(assigned.status).toBe(200);
    expect(assigned.text).toContain("Support assignment recorded");
    const grantId = assigned.text.match(
      /data-assignment-grant>([0-9a-f-]{36})</,
    )![1]!;
    const detailPath = `/operator/support/${requestId}?grant=${grantId}`;
    const worklist = await operator.open("/operator/support");
    expect(worklist.text).toContain(
      `/operator/support/${requestId}?grant=${grantId}`,
    );
    let detail = await operator.open(detailPath);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("PREVIEW-SUPPORT-PRIVATE-BODY");
    // Opening is not an acknowledgement.
    expect(detail.text).toContain("No separate acknowledgement recorded");

    // SUPPREVIEW-03: separate note, acknowledgement, reply and resolution.
    const base = `/operator/support/${requestId}`;
    expect(
      (
        await operator.submit(detail.text, `${base}/notes`, {
          body: "PREVIEW-INTERNAL-NOTE-ONLY",
          confirm: "yes",
        })
      ).location,
    ).toBe(detailPath);
    detail = await operator.open(detailPath);
    expect(
      (
        await operator.submit(detail.text, `${base}/acknowledge`, {
          confirm: "yes",
        })
      ).location,
    ).toBe(detailPath);
    detail = await operator.open(detailPath);
    expect(detail.text).toContain("Acknowledged <time datetime=");
    expect(
      (
        await operator.submit(detail.text, `${base}/replies`, {
          body: "PREVIEW-VISIBLE-REPLY",
          confirm: "yes",
        })
      ).location,
    ).toBe(detailPath);
    const memberBeforeResolution = await member.open(`/support/${requestId}`);
    expect(memberBeforeResolution.text).toContain("PREVIEW-VISIBLE-REPLY");
    expect(memberBeforeResolution.text).toContain(
      "Acknowledged <time datetime=",
    );
    expect(memberBeforeResolution.text).toContain(
      "Open; no resolution recorded",
    );
    detail = await operator.open(detailPath);
    expect(
      (
        await operator.submit(detail.text, `${base}/resolve`, {
          confirm: "yes",
        })
      ).location,
    ).toBe(detailPath);
    const resolved = await member.open(`/support/${requestId}`);
    expect(resolved.text).toContain("PREVIEW-VISIBLE-REPLY");
    expect(resolved.text).toContain("Resolved <time datetime=");
    expect(resolved.text).toContain("does not establish member satisfaction");
    expect(resolved.text).not.toContain("PREVIEW-INTERNAL-NOTE-ONLY");
    const exported = await member.open("/api/member/export");
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("PREVIEW-VISIBLE-REPLY");
    expect(exported.text).not.toContain("PREVIEW-INTERNAL-NOTE-ONLY");

    // SUPPREVIEW-04: revoking the exact grant denies fresh operator reads.
    const history = await admin.open(
      `/operator/support-assignment/history?requestId=${requestId}`,
    );
    const revoked = await admin.submit(
      history.text,
      "/operator/support-assignment/revoke",
      { confirm: "yes" },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.text).toContain("Support assignment revoked");
    const writes = async () =>
      (
        await db!.query(
          "SELECT (SELECT count(*) FROM support_request_notes)::int + (SELECT count(*) FROM support_request_replies)::int + (SELECT count(*) FROM support_request_events)::int AS n",
        )
      ).rows[0].n;
    const before = await writes();
    const denied = await operator.open(detailPath);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain("PREVIEW-SUPPORT-PRIVATE-BODY");
    expect(
      (
        await operator.submit(detail.text, `${base}/notes`, {
          body: "PREVIEW-AFTER-REVOCATION",
          confirm: "yes",
        })
      ).status,
    ).toBe(403);
    expect(await writes()).toBe(before);
    expect((await operator.open("/operator/support")).text).not.toContain(
      requestId,
    );
    const retained = await member.open(`/support/${requestId}`);
    expect(retained.status).toBe(200);
    expect(retained.text).toContain("PREVIEW-VISIBLE-REPLY");
    expect(retained.text).toContain("Resolved <time datetime=");
    for (const secret of [
      metadata.operatorCredential,
      metadata.administratorCredential,
    ])
      expect(proc.output().includes(secret)).toBe(false);
    await db.end();
    db = undefined;
    expect(await stop(proc.child, proc.exited)).toBe(0);
    expect(existsSync(metadata.privateRoot)).toBe(false);
  } finally {
    await db?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
  }
}, 150000);

it("WFPREVIEW-01/02/03 rehearses an exact private workflow-note review request, administrator assignment, moderator reading and member withdrawal through ordinary forms", async () => {
  const proc = start();
  let db: Pool | undefined;
  try {
    const ready = await proc.ready;
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    db = new Pool({ connectionString: metadata.database });
    // WFPREVIEW-01: reuses the existing identities; nothing is seeded.
    const staff = (await db.query("SELECT count(*)::int n FROM staff_profiles"))
      .rows[0].n;
    for (const table of [
      "workflow_feedback",
      "workflow_review_requests",
      "workflow_review_grants",
      "workflow_review_operations",
    ])
      expect(
        (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    const moderator = browserFor(ready.origin);
    await moderator.signIn(metadata.moderatorCredential);
    const reference = await moderator.open(
      "/moderate/workflow-review-reference",
    );
    expect(reference.status).toBe(200);
    expect(reference.text).toContain(metadata.moderatorId);
    const emptyWorklist = await moderator.open("/moderate/workflow-reviews");
    expect(emptyWorklist.status).toBe(200);
    expect(emptyWorklist.text).not.toContain("/moderate/workflow-reviews/");

    // WFPREVIEW-02: member saves a note and explicitly requests review.
    const member = browserFor(ready.origin);
    const welcome = await member.open("/");
    expect(
      (
        await member.submit(welcome.text, "/start", {
          background: "technical",
          goal: "build",
          synthetic: "yes",
        })
      ).status,
    ).toBe(303);
    const note = "PREVIEW-WORKFLOW-NOTE: clarify the checking step";
    const feedback = await member.open("/workflow-feedback/WF-001");
    expect(
      (
        await member.submit(feedback.text, "/workflow-feedback/WF-001/save", {
          note,
          confirm: "yes",
        })
      ).status,
    ).toBe(303);
    const preview = await member.open("/workflow-feedback/WF-001/review");
    expect(preview.status).toBe(200);
    expect(preview.text).toContain(note);
    let requested = await member.submit(
      preview.text,
      "/workflow-feedback/review/request",
      { confirm: "yes" },
    );
    if (requested.status === 303)
      requested = await member.open(requested.location!);
    const requestId = requested.text.match(/data-request-id="([^"]+)"/)![1]!;

    const admin = browserFor(ready.origin);
    await admin.signIn(metadata.administratorCredential);
    const assignment = await admin.open("/operator/workflow-reviews");
    expect(assignment.status).toBe(200);
    const checked = await admin.submit(
      assignment.text,
      "/operator/workflow-reviews/check",
      { requestId, moderatorId: metadata.moderatorId },
    );
    expect(checked.status).toBe(200);
    expect(checked.text).not.toContain(note);
    const assigned = await admin.submit(
      checked.text,
      "/operator/workflow-reviews/assign",
      { confirm: "yes" },
    );
    expect(assigned.status).toBe(200);
    expect(assigned.text).not.toContain(note);
    const grantId = assigned.text.match(/data-grant-id="([^"]+)"/)![1]!;
    const worklist = await moderator.open("/moderate/workflow-reviews");
    expect(worklist.text).toContain(`/moderate/workflow-reviews/${grantId}`);
    const read = await moderator.open(`/moderate/workflow-reviews/${grantId}`);
    expect(read.status).toBe(200);
    expect(read.text).toContain(note);
    expect(read.text).toContain("WF-001 · version 1 · revision 1");
    // A learner cannot use the moderator reader.
    expect(
      (await member.open(`/moderate/workflow-reviews/${grantId}`)).status,
    ).toBe(403);

    // WFPREVIEW-03: withdrawal keeps the note and denies fresh reads.
    const receipt = await member.open(
      `/workflow-feedback/review/receipts/${requestId}`,
    );
    const withdrawn = await member.submit(
      receipt.text,
      "/workflow-feedback/review/withdraw",
      { confirm: "yes" },
    );
    expect([200, 303]).toContain(withdrawn.status);
    const denied = await moderator.open(
      `/moderate/workflow-reviews/${grantId}`,
    );
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain(note);
    expect((await member.open("/workflow-feedback/WF-001")).text).toContain(
      note,
    );
    // No identity was added for this rehearsal.
    expect(
      (await db.query("SELECT count(*)::int n FROM staff_profiles")).rows[0].n,
    ).toBe(staff);
    for (const secret of [
      metadata.moderatorCredential,
      metadata.administratorCredential,
    ])
      expect(proc.output().includes(secret)).toBe(false);
    await db.end();
    db = undefined;
    expect(await stop(proc.child, proc.exited)).toBe(0);
    expect(existsSync(metadata.privateRoot)).toBe(false);
  } finally {
    await db?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
  }
}, 150000);

it("PREVIEW-04 refuses to force-drop its database when a separate connection remains", async () => {
  const proc = start();
  let foreign: Pool | undefined;
  let heldConnection: PoolClient | undefined;
  let observer: Client | undefined, sampling: Promise<void> | undefined;
  let observing = false,
    observationFailed = false,
    removalObserved = false;
  let samples = 0;
  let privateRoot: string | undefined, own: string | undefined;
  try {
    const ready = await proc.ready;
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    privateRoot = metadata.privateRoot;
    own = new URL(metadata.database).pathname.slice(1);
    foreign = new Pool({ connectionString: metadata.database });
    // Keep the foreign connection checked out until explicit recovery. An idle
    // pooled connection otherwise expires after ten seconds under a slow gate.
    heldConnection = await foreign.connect();
    await heldConnection.query("SELECT 1");
    // CLOSE-DDL-02: bounded observation supplements source review of the
    // positive-session branch before dedicated Client construction. Sampling
    // cannot prove that no transient connection ever existed.
    const observerUrl = new URL(metadata.database);
    observerUrl.pathname = "/postgres";
    observer = new Client({
      connectionString: observerUrl.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 1000,
      query_timeout: 2000,
      application_name: "dne-preview-refusal-observer",
    });
    observer.on("error", () => {
      observationFailed = true;
    });
    await observer.connect();
    observing = true;
    const observationDeadline = Date.now() + 25000;
    const ownDrop = `DROP DATABASE "${own}"`;
    const activeObserver = observer;
    sampling = (async () => {
      try {
        while (observing && Date.now() < observationDeadline) {
          const observed = await activeObserver.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND query=$2",
            ["dne-owner-preview-drop", ownDrop],
          );
          samples++;
          removalObserved ||= observed.rows[0].n > 0;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch {
        observationFailed = true;
      }
    })();
    const refusalExit = await stop(proc.child, proc.exited);
    observing = false;
    await sampling;
    expect(refusalExit).toBe(1);
    expect(
      (await heldConnection.query("SELECT current_database() AS name")).rows[0]
        .name,
    ).toBe(own);
    expect(existsSync(privateRoot!)).toBe(true);
    const retained = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    expect(retained.cleanup).toContain("Cleanup blocked");
    // A positive owned-session observation is a deliberate refusal, not a
    // fabricated PostgreSQL error or a race between its DROP/statement timers.
    expect(retained.cleanupKind).toBe("owned-session-present");
    expect(retained.cleanupStage).toBe("session-refusal");
    expect(cleanupDiagnostic(retained).code).toBe("absent");
    expect(retained.cleanupCode).toBeUndefined();
    expect(proc.output().includes(metadata.database)).toBe(false);
    expect(proc.output()).toContain("Do not force-drop other connections");
    console.info(
      "CLOSE-DDL-02 observation",
      JSON.stringify({
        removal: removalObserved ? "observed" : "none observed",
        samples,
        observationFailed,
      }),
    );
    expect(observationFailed).toBe(false);
    expect(samples).toBeGreaterThan(0);
    expect(removalObserved).toBe(false);
  } finally {
    observing = false;
    await sampling;
    await observer?.end().catch(() => {
      observationFailed = true;
    });
    heldConnection?.release();
    await foreign?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
    // Explicit test-owned recovery after the foreign connection closes. The
    // first cleanup refusal stays evidenced; this is not an automatic retry.
    if (own && /^dne_test_[a-f0-9]{32}$/.test(own))
      await control.query(`DROP DATABASE "${own}"`);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
    expect(observationFailed).toBe(false);
  }
}, 150000);

it("PREVIEW-04 waits for a slowly closing session before its single ordinary drop", async () => {
  // A loaded gate can leave a just-closed backend alive for longer than
  // PostgreSQL's own five-second DROP wait. Model that with a session that
  // leaves ten seconds after the stop request.
  const proc = start();
  let lingering: Pool | undefined, held: PoolClient | undefined;
  try {
    const ready = await proc.ready;
    const metadata = JSON.parse(await readFile(ready.staffSetupFile, "utf8"));
    const own = new URL(metadata.database).pathname.slice(1);
    lingering = new Pool({ connectionString: metadata.database });
    held = await lingering.connect();
    await held.query("SELECT 1");
    const stopped = stop(proc.child, proc.exited);
    await new Promise((resolve) => setTimeout(resolve, 10000));
    held.release();
    held = undefined;
    await lingering.end();
    lingering = undefined;
    expect(await stopped).toBe(0);
    expect(existsSync(metadata.privateRoot)).toBe(false);
    expect(
      (
        await control.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname=$1",
          [own],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    held?.release();
    await lingering?.end();
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
  }
}, 150000);

it("PREVIEW-03/04 rejects unsafe configuration and cleans failed local resource setup without logging private driver details", async () => {
  const denied = spawnSync(process.execPath, ["scripts/private-preview.mjs"], {
    env: {
      ...previewEnvironment(),
      DNE_PREVIEW_CONTROL_URL:
        "postgresql://synthetic-private-secret@remote.example.invalid/postgres",
    },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain("failed at configuration");
  expect(
    (denied.stdout + denied.stderr).includes("synthetic-private-secret"),
  ).toBe(false);
  const badAccount = new URL(process.env.DNE_TEST_DATABASE_URL!);
  badAccount.username = "dne_absent_" + randomBytes(8).toString("hex");
  badAccount.password = "synthetic-private-secret";
  const failed = spawnSync(process.execPath, ["scripts/private-preview.mjs"], {
    env: { ...previewEnvironment(), DNE_PREVIEW_CONTROL_URL: badAccount.href },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("failed at resource setup");
  expect(
    (failed.stdout + failed.stderr).includes("synthetic-private-secret"),
  ).toBe(false);
  expect(
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith(`dne-owner-preview-${failed.pid}-`),
    ),
  ).toEqual([]);
  const exposed = spawnSync(process.execPath, ["scripts/private-preview.mjs"], {
    env: { ...previewEnvironment(), TMPDIR: join(process.cwd(), "public") },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(exposed.status).toBe(1);
  expect(exposed.stderr).toContain("failed at private storage");
  expect(
    (await readdir("public")).filter((name) =>
      name.startsWith(`dne-owner-preview-${exposed.pid}-`),
    ),
  ).toEqual([]);
}, 90000);

it("PREVIEW-04 retains an owned recovery record when PostgreSQL committed CREATE but its acknowledgement was lost", async () => {
  const target = new URL(process.env.DNE_TEST_DATABASE_URL!);
  const sockets = new Set<Socket>();
  let droppedReply = false;
  const proxy = createServer((client) => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    let buffered: Buffer = Buffer.alloc(0);
    upstream.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const size = buffered.readUInt32BE(1) + 1;
        if (buffered.length < size) return;
        const message = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        // This is a real PostgreSQL CommandComplete after its CREATE committed,
        // not a mocked transaction result. Lose exactly its first wire reply.
        if (
          !droppedReply &&
          message[0] === 67 &&
          message.subarray(5).toString() === "CREATE DATABASE\0"
        ) {
          droppedReply = true;
          client.destroy();
          upstream.destroy();
          return;
        }
        client.write(message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw Error("Missing owned fault fixture listener");
  const viaProxy = new URL(target);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(address.port);
  const before = new Set(await readdir(tmpdir()));
  const proc = start(viaProxy.href);
  let privateRoot: string | undefined, own: string | undefined;
  try {
    // Rejecting readiness is the expected fault outcome; retain the first failure.
    await expect(proc.ready).rejects.toThrow("exited before ready");
    expect(await proc.exited).toBe(1);
    expect(droppedReply).toBe(true);
    const retained = (await readdir(tmpdir())).filter(
      (name) =>
        name.startsWith(`dne-owner-preview-${proc.child.pid}-`) &&
        !before.has(name),
    );
    expect(retained.length).toBe(1);
    privateRoot = join(tmpdir(), retained[0]!);
    const record = JSON.parse(
      await readFile(join(privateRoot, "runtime-private.json"), "utf8"),
    );
    own = new URL(record.database).pathname.slice(1);
    expect(record.cleanup).toContain("acknowledgement is incomplete");
    expect(
      (
        await control.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname=$1",
          [own],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(proc.output()).toContain("Owned cleanup is blocked");
    expect(proc.output().includes(record.database)).toBe(false);
  } finally {
    if (proc.child.exitCode === null) await stop(proc.child, proc.exited);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    // The test witnessed the commit at its controlled wire boundary. Explicitly
    // clean this test-owned database after preserving the refusal evidence.
    if (own && /^dne_test_[a-f0-9]{32}$/.test(own))
      await control.query(`DROP DATABASE "${own}"`);
    if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
  }
}, 150000);

it("CLOSE-DDL-01/04 awaits native owned removal past the former thirty-second limit with exact lock evidence", async () => {
  let ownedPreview: Awaited<ReturnType<typeof launchPreview>> | undefined;
  let unexpectedFixtureFailure = false;
  try {
    const preview = await launchPreview({
      DNE_PREVIEW_CONTROL_URL: process.env.DNE_TEST_DATABASE_URL,
    });
    ownedPreview = preview;
    const record = JSON.parse(await readFile(preview.metadataFile, "utf8"));
    const own = new URL(record.database).pathname.slice(1);
    if (!/^dne_test_[a-f0-9]{32}$/.test(own))
      throw new Error("Invalid owned launcher fixture identity");
    const adminUrl = new URL(record.database);
    adminUrl.pathname = "/postgres";
    const holder = new Client({
      connectionString: adminUrl.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    // These are test-owned read-only observations. Neither observer deadline
    // nor an observer failure controls the independently scheduled lock release.
    const observer = new Client({
      connectionString: adminUrl.href,
      connectionTimeoutMillis: 3000,
      statement_timeout: 1000,
      query_timeout: 2000,
    });
    const originalQuery = Client.prototype.query;
    const native = (client: Client, text: string) =>
      Reflect.apply(originalQuery, client, [text]) as Promise<QueryResult>;
    const alias = "dne_test_" + randomBytes(16).toString("hex");
    let locked = false,
      releaseTask: Promise<void> | undefined;
    let observationTask: Promise<void> | undefined;
    let settled = false,
      dropPid = 0,
      holderPid = 0,
      ownOid = 0;
    let calls = 0,
      proof = false,
      clean = false,
      nativeCode = "absent";
    let controlBudget = "unknown",
      dropBudget = "unknown",
      elapsedMs = 0;
    let recoveryDrops = 0,
      backendTerminal = false,
      absent = false;
    let fixtureCause = "absent";
    const fixtureFailed = (cause: string) => {
      if (fixtureCause === "absent") fixtureCause = cause;
    };
    holder.on("error", () => fixtureFailed("holder-client-error"));
    observer.on("error", () => fixtureFailed("observer-client-error"));
    const hook = vi
      .spyOn(Client.prototype, "query")
      .mockImplementation(function (
        this: Client,
        text: unknown,
        ...rest: unknown[]
      ) {
        if (text !== `DROP DATABASE "${own}"`)
          return Reflect.apply(originalQuery, this, [text, ...rest]);
        calls++;
        const operation = async () => {
          const settings = (
            await native(
              this,
              "SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS budget",
            )
          ).rows[0];
          dropPid = settings.pid;
          dropBudget = settings.budget;
          await native(holder, "BEGIN");
          locked = true;
          // Only the launcher's acknowledged generated database is renamed, and
          // the transaction is always rolled back. No target connection is held.
          await native(holder, `ALTER DATABASE "${own}" RENAME TO "${alias}"`);
          const began = performance.now();
          const result = native(this, text as string);
          releaseTask = (async () => {
            // This task does not await any observation. 31 seconds exceeds the
            // former 30s DDL budget; it is fixture release, not a DROP retry.
            await new Promise((resolve) => setTimeout(resolve, 31000));
            try {
              await native(holder, "ROLLBACK");
              locked = false;
            } catch {
              fixtureFailed("holder-rollback");
            }
          })();
          observationTask = (async () => {
            try {
              const deadline = Date.now() + 4000;
              while (Date.now() < deadline) {
                const observed = (
                  await observer.query(
                    `SELECT
                  EXISTS(SELECT 1 FROM pg_locks WHERE locktype='object' AND classid='pg_database'::regclass AND objid=$1 AND pid=$2 AND mode='AccessExclusiveLock' AND granted) AS held,
                  EXISTS(SELECT 1 FROM pg_locks WHERE locktype='object' AND classid='pg_database'::regclass AND objid=$1 AND pid=$3 AND mode='AccessExclusiveLock' AND NOT granted) AS waiting,
                  $2::int = ANY(pg_blocking_pids($3::int)) AS blocked,
                  (SELECT count(*)::int FROM pg_stat_activity WHERE datname=$4) AS sessions`,
                    [ownOid, holderPid, dropPid, own],
                  )
                ).rows[0];
                if (
                  observed.held &&
                  observed.waiting &&
                  observed.blocked &&
                  observed.sessions === 0
                ) {
                  proof = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            } catch {
              fixtureFailed("lock-observation");
            }
          })();
          try {
            return await result;
          } catch (error) {
            nativeCode = cleanupDiagnostic({
              cleanupCode: (error as { code?: unknown }).code,
            }).code;
            throw error;
          } finally {
            settled = true;
            elapsedMs = performance.now() - began;
          }
        };
        // The unchanged Pool delegates a callback; the administrative Client uses
        // a promise. Preserve both actual pg signatures and native settlement.
        const callback = rest.at(-1);
        if (typeof callback === "function") {
          void operation().then(
            (result) => callback(null, result),
            (error: unknown) => callback(error),
          );
          return;
        }
        return operation();
      } as Client["query"]);
    try {
      await observer.connect();
      await holder.connect();
      holderPid = (await native(holder, "SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      ownOid = (
        await observer.query("SELECT oid FROM pg_database WHERE datname=$1", [
          own,
        ])
      ).rows[0].oid;
      const poolQuery = Pool.prototype.query;
      const poolHook = vi
        .spyOn(Pool.prototype, "query")
        .mockImplementation(function (
          this: Pool,
          text: unknown,
          ...rest: unknown[]
        ) {
          if (
            text ===
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1" &&
            Array.isArray(rest[0]) &&
            rest[0][0] === own
          ) {
            return (async () => {
              // SHOW uses the same configured control pool; it does not claim
              // that two pool checkouts are the same physical connection.
              const setting = await Reflect.apply(poolQuery, this, [
                "SHOW statement_timeout",
              ]);
              controlBudget = setting.rows[0].statement_timeout;
              return Reflect.apply(poolQuery, this, [text, ...rest]);
            })();
          }
          return Reflect.apply(poolQuery, this, [text, ...rest]);
        } as Pool["query"]);
      try {
        const first = preview.close();
        const second = preview.close();
        [clean] = await Promise.all([first, second]);
      } finally {
        poolHook.mockRestore();
      }
      await Promise.all([releaseTask, observationTask]);
    } finally {
      // Close shares its existing promise; this never starts a second DROP.
      await preview.close().catch(() => {
        fixtureFailed("preview-close");
      });
      await Promise.all([releaseTask, observationTask]);
      hook.mockRestore();
      try {
        if (locked) {
          try {
            await native(holder, "ROLLBACK");
            locked = false;
          } catch {
            fixtureFailed("holder-rollback");
          }
        }
      } finally {
        // Attempt end even after an uncertain/failed connection receipt.
        await holder.end().catch(() => fixtureFailed("holder-close"));
      }
      try {
        if (settled) {
          const deadline = Date.now() + 3000;
          do {
            backendTerminal = !(
              await observer.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present",
                [dropPid],
              )
            ).rows[0].present;
            if (backendTerminal) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          } while (Date.now() < deadline);
        }
        if (settled && backendTerminal && !locked) {
          const present = (
            await observer.query(
              "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS present",
              [own],
            )
          ).rows[0].present;
          if (present) {
            // Separate ordinary operator recovery only after actual native
            // settlement/backend absence. It has its own finite server budget.
            const recovery = new Client({
              connectionString: adminUrl.href,
              connectionTimeoutMillis: 3000,
              statement_timeout: 90000,
            });
            recovery.on("error", () => fixtureFailed("recovery-client-error"));
            try {
              await recovery.connect();
              recoveryDrops++;
              await recovery.query(`DROP DATABASE "${own}"`);
            } finally {
              await recovery.end();
            }
          }
          absent = !(
            await observer.query(
              "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS present",
              [own],
            )
          ).rows[0].present;
          if (absent && !clean)
            await rm(preview.privateRoot, { recursive: true, force: true });
        }
      } finally {
        await observer.end().catch(() => fixtureFailed("observer-close"));
      }
    }
    const summary = {
      scenario: "CLOSE-DDL-01/04",
      proof,
      calls,
      nativeCode,
      elapsedMs: Math.floor(elapsedMs),
      controlBudget,
      dropBudget,
      clean,
      backendTerminal,
      recoveryDrops,
      absent,
      fixtureCause,
      diagnostic: preview.cleanupDiagnostic(),
    };
    console.info(JSON.stringify(summary));
    expect(
      proof,
      "Exact owned database holder/waiter/blocker/zero-session proof",
    ).toBe(true);
    expect(fixtureCause).toBe("absent");
    expect(clean, JSON.stringify(summary)).toBe(true);
    expect(calls).toBe(1);
    expect(nativeCode).toBe("absent");
    expect(elapsedMs).toBeGreaterThan(30000);
    expect(controlBudget).toBe("5s");
    expect(dropBudget).toBe("90s");
    expect(backendTerminal).toBe(true);
    expect(recoveryDrops).toBe(0);
    expect(absent).toBe(true);
    expect(existsSync(preview.privateRoot)).toBe(false);
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") throw error;
    unexpectedFixtureFailure = true;
  } finally {
    // Protect the returned runtime even if metadata parsing or fixture setup
    // fails before the inner lock/observer cleanup is established.
    await ownedPreview?.close().catch(() => {
      throw new Error("CLOSE-DDL owned preview cleanup remains incomplete");
    });
  }
  if (unexpectedFixtureFailure)
    throw new Error(
      "CLOSE-DDL native fixture failed; inspect its private owned recovery record",
    );
}, 150000);
