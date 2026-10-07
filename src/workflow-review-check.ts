import { createHmac, timingSafeEqual } from "node:crypto";
import { sampleUuid } from "./sample-feedback-values.ts";
import { sampleAssignmentUtc } from "./sample-assignment-values.ts";
import type { WorkflowReviewChecked } from "./workflow-review.ts";

export function workflowReviewCheck(secret: string) {
  const mac = (text: string) =>
    createHmac("sha256", secret)
      .update("workflow-review-preview-v1\0" + text)
      .digest();
  return {
    sign(value: WorkflowReviewChecked): string {
      const text = Buffer.from(JSON.stringify(value)).toString("base64url");
      return text + "." + mac(text).toString("base64url");
    },
    read(packet: unknown): WorkflowReviewChecked | null {
      if (
        typeof packet !== "string" ||
        packet.length > 2048 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(packet)
      )
        return null;
      const [text, signature] = packet.split(".") as [string, string];
      const decoded = Buffer.from(signature, "base64url");
      const expected = mac(text);
      if (
        decoded.length !== expected.length ||
        !timingSafeEqual(decoded, expected)
      )
        return null;
      try {
        const value = JSON.parse(
          Buffer.from(text, "base64url").toString("utf8"),
        );
        const fields = [
          "workflowId",
          "workflowVersion",
          "instanceId",
          "revision",
          "memberId",
          "expiresAt",
        ];
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== fields.length ||
          !fields.every((key) => Object.hasOwn(value, key)) ||
          typeof value.workflowId !== "string" ||
          !/^WF-\d{3}$/.test(value.workflowId) ||
          !Number.isSafeInteger(value.workflowVersion) ||
          value.workflowVersion < 1 ||
          !Number.isSafeInteger(value.revision) ||
          value.revision < 1 ||
          !sampleUuid(value.instanceId) ||
          !sampleUuid(value.memberId) ||
          !sampleAssignmentUtc(value.expiresAt)
        )
          return null;
        return value as WorkflowReviewChecked;
      } catch {
        return null;
      }
    },
  };
}
