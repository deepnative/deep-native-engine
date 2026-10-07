import { createHmac, timingSafeEqual } from "node:crypto";
import { sampleUuid } from "./sample-feedback-values.ts";
interface Cursor {
  actorId: string;
  createdAt: string;
  id: string;
}
export function workflowReviewCursor(
  secret: string,
  purpose: "worklist" | "member-history" | "attendance-history",
) {
  const mac = (text: string) =>
    createHmac("sha256", secret)
      .update(`workflow-review-${purpose}-v1\0` + text)
      .digest();
  return {
    sign(c: Cursor) {
      const text = Buffer.from(JSON.stringify(c)).toString("base64url");
      return text + "." + mac(text).toString("base64url");
    },
    read(value: unknown): Cursor | null {
      if (
        typeof value !== "string" ||
        value.length > 1024 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)
      )
        return null;
      const [text, sig] = value.split(".") as [string, string],
        actual = Buffer.from(sig, "base64url"),
        expected = mac(text);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return null;
      try {
        const c = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
        if (
          !c ||
          typeof c !== "object" ||
          Array.isArray(c) ||
          Object.keys(c).length !== 3 ||
          !sampleUuid(c.actorId) ||
          !sampleUuid(c.id) ||
          typeof c.createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.createdAt) ||
          !Number.isFinite(Date.parse(c.createdAt))
        )
          return null;
        return c as Cursor;
      } catch {
        return null;
      }
    },
  };
}
