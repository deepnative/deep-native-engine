import { expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import {
  attachNativeSubmissionFailure,
  nativeSubmissionCollector,
  observeNativeSubmission,
} from "../e2e/native-submission-observation.ts";

it("L102-OBS-01 attaches collected failure evidence without asking an unavailable renderer", async () => {
  const evaluate = vi.fn().mockRejectedValue(new Error("Unavailable renderer"));
  const page = {
    context: () => ({ exposeBinding: vi.fn(), addInitScript: vi.fn() }),
    on: vi.fn(),
    evaluate,
  } as unknown as Page;
  const observation = await observeNativeSubmission(page);
  observation.collector.native({
    type: "keydown",
    key: "Enter",
    trusted: true,
  });
  const attach = vi.fn();
  await observation.finish({
    status: "failed",
    expectedStatus: "passed",
    attach,
  });
  expect(attach).toHaveBeenCalledOnce();
  expect(evaluate).not.toHaveBeenCalled();
});

it("L102-OBS-01 distinguishes invalid native confirmation from a submitted withdrawal", () => {
  const denied = nativeSubmissionCollector();
  denied.native({
    type: "invalid",
    trusted: true,
    formValid: false,
    target: { tag: "INPUT", type: "checkbox" },
  });
  expect(denied.evidence().events).toEqual([
    expect.objectContaining({
      type: "invalid",
      trusted: true,
      formValid: false,
    }),
  ]);
  const submitted = nativeSubmissionCollector();
  submitted.native({
    type: "submit",
    trusted: true,
    formValid: true,
    active: { tag: "BUTTON", type: "submit" },
  });
  submitted.request(
    "POST",
    "http://127.0.0.1:4317/exercise/clear-instructions/1/withdraw",
    303,
  );
  expect(submitted.evidence().events).toEqual([
    expect.objectContaining({ type: "submit", trusted: true, formValid: true }),
    { kind: "response", method: "POST", route: "withdrawal", status: 303 },
  ]);
});

it("L102-OBS-02 excludes private values, arbitrary attributes and URLs at the serialization boundary", () => {
  const collector = nativeSubmissionCollector();
  const marker = "PRIVATE-MEMBER-SECRET-MARKER";
  collector.native({
    type: "keydown",
    key: marker,
    target: { tag: marker, type: marker, value: marker, name: marker },
    active: { tag: "INPUT", value: marker },
    document: marker,
    at: Infinity,
    formValid: marker,
    cookies: marker,
    csrf: marker,
    body: marker,
    defaultPrevented: marker,
  });
  collector.request(
    marker,
    `https://${marker}.example/private?token=${marker}`,
    999,
  );
  const serialized = JSON.stringify(collector.evidence());
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("rawHtml");
  expect(serialized).not.toContain("csrf");
  expect(collector.evidence().events).toEqual([
    expect.objectContaining({
      key: null,
      target: { tag: "OTHER", type: null },
      document: null,
      at: null,
      formValid: null,
    }),
    { kind: "response", method: "other", route: "other", status: null },
  ]);
});

it("L102-OBS-02 bounds a flood and marks truncation rather than retaining oversized input", () => {
  const collector = nativeSubmissionCollector();
  const oversized = "PRIVATE".repeat(10000);
  collector.native(null);
  collector.native([oversized]);
  collector.native({ type: oversized });
  for (let index = 0; index < 1000; index++) {
    collector.native({
      type: "keydown",
      key: "Enter",
      target: { tag: "BUTTON", type: "submit", value: oversized },
      at: index,
    });
    collector.request("POST", `https://example.com/${oversized}`);
  }
  const evidence = collector.evidence();
  expect(evidence.truncated).toBe(true);
  expect(evidence.discarded).toBe(3);
  expect(evidence.events.length).toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(64 * 1024);
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
});

it("L102-OBS-02 reports incomplete capture without retaining error details", async () => {
  const collector = nativeSubmissionCollector();
  collector.request("GET", "invalid private URL");
  collector.request("GET", "http://127.0.0.1/lesson?private=hidden");
  collector.captureFailed();
  const attach = vi.fn();
  await attachNativeSubmissionFailure(
    { status: "failed", expectedStatus: "passed", attach },
    collector,
  );
  expect(attach).toHaveBeenCalledOnce();
  const [name, attachment] = attach.mock.calls[0]!;
  expect(name).toBe("native-submission-observation");
  const evidence = JSON.parse(attachment.body.toString());
  expect(evidence.captureFailed).toBe(true);
  expect(evidence.navigationDeliveryGuaranteed).toBe(false);
  expect(evidence.events).toEqual([
    { kind: "request", method: "GET", route: "other", status: null },
    { kind: "request", method: "GET", route: "lesson", status: null },
  ]);
  expect(attachment.body.toString()).not.toContain("private");
});

it("L102-OBS-01 adds no attachment to an expected passing result", async () => {
  const attach = vi.fn();
  await attachNativeSubmissionFailure(
    { status: "passed", expectedStatus: "passed", attach },
    nativeSubmissionCollector(),
  );
  expect(attach).not.toHaveBeenCalled();
});
