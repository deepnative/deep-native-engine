import { createHmac, timingSafeEqual } from "node:crypto";
import { hash } from "./store.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import type { SampleAssignmentSource } from "./sample-assignment-values.ts";

export interface SampleAssignmentHistoryKey {
  at: string;
  id: string;
}
export interface SampleAssignmentContinuation extends SampleAssignmentHistoryKey {
  expires: number;
}
/** Navigation only: every page independently rechecks current administrator
 * and workspace authority. The initial cursor expiry is never renewed. */
export function sampleAssignmentCursor(secret: Buffer) {
  const signature = (
    token: string,
    source: SampleAssignmentSource,
    body: string,
  ) =>
    createHmac("sha256", secret)
      .update(hash(token))
      .update("\0sample-assignment-history\0")
      .update(source.evidenceId)
      .update("\0")
      .update(String(source.sourceRevision))
      .update("\0")
      .update(body)
      .digest("base64url");
  return {
    encode(
      token: string,
      source: SampleAssignmentSource,
      key: SampleAssignmentHistoryKey,
      expires = Date.now() + 900000,
    ) {
      const body = Buffer.from(
        JSON.stringify([key.at, key.id, expires]),
      ).toString("base64url");
      return `${body}.${signature(token, source, body)}`;
    },
    decode(
      token: string,
      source: SampleAssignmentSource,
      value: string | undefined,
    ): SampleAssignmentContinuation | null | "invalid" {
      if (value === undefined) return null;
      if (value.length > 1024) return "invalid";
      const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (
        !parts ||
        !timingSafeEqual(
          Buffer.from(parts[2]!),
          Buffer.from(signature(token, source, parts[1]!)),
        )
      )
        return "invalid";
      let data: unknown;
      try {
        data = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      } catch {
        return "invalid";
      }
      if (
        !Array.isArray(data) ||
        data.length !== 3 ||
        typeof data[0] !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(data[0]) ||
        !Number.isFinite(Date.parse(data[0])) ||
        new Date(data[0]).toISOString() !== data[0].slice(0, 23) + "Z" ||
        typeof data[1] !== "string" ||
        !sampleUuid(data[1]) ||
        !Number.isSafeInteger(data[2]) ||
        data[2] <= Date.now()
      )
        return "invalid";
      return { at: data[0], id: data[1], expires: data[2] };
    },
  };
}
