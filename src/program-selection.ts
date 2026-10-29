import { createHmac, timingSafeEqual } from "node:crypto";
import { uniqueCookie } from "./staff-entry-selection.ts";
import {
  PROGRAM_CONFIRM_PATH,
  PROGRAM_DIGEST,
  PROGRAM_MANIFEST,
} from "./program-values.ts";

export const PROGRAM_SELECTION_COOKIE = "dne_program_selection";
export const PROGRAM_SELECTION_MS = 15 * 60 * 1000;
const signature = (value: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`program-selection-v1:${value}`)
    .digest("hex");
export function issueProgramSelection(secret: string, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({
      programId: PROGRAM_MANIFEST.programId,
      programVersion: PROGRAM_MANIFEST.programVersion,
      termId: PROGRAM_MANIFEST.termId,
      termVersion: PROGRAM_MANIFEST.termVersion,
      digest: PROGRAM_DIGEST,
      expires: now + PROGRAM_SELECTION_MS,
    }),
  ).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}
export function readProgramSelection(
  rawCookie: string | undefined,
  secret: string,
  now = Date.now(),
): "absent" | "invalid" | "ready" {
  const cookie = uniqueCookie(rawCookie, PROGRAM_SELECTION_COOKIE);
  if (cookie.kind === "absent") return "absent";
  if (cookie.kind !== "value" || cookie.value.length > 1024) return "invalid";
  const parts = cookie.value.split(".");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]!) ||
    !/^[a-f0-9]{64}$/.test(parts[1]!) ||
    !timingSafeEqual(
      Buffer.from(parts[1]!, "hex"),
      Buffer.from(signature(parts[0]!, secret), "hex"),
    )
  )
    return "invalid";
  try {
    const v = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    return v &&
      Object.keys(v).sort().join(",") ===
        "digest,expires,programId,programVersion,termId,termVersion" &&
      v.programId === PROGRAM_MANIFEST.programId &&
      v.programVersion === PROGRAM_MANIFEST.programVersion &&
      v.termId === PROGRAM_MANIFEST.termId &&
      v.termVersion === PROGRAM_MANIFEST.termVersion &&
      v.digest === PROGRAM_DIGEST &&
      Number.isSafeInteger(v.expires) &&
      v.expires > now &&
      v.expires <= now + PROGRAM_SELECTION_MS
      ? "ready"
      : "invalid";
  } catch {
    return "invalid";
  }
}
export function programResumeTarget(
  rawCookie: string | undefined,
  secret: string,
) {
  return readProgramSelection(rawCookie, secret) === "ready"
    ? PROGRAM_CONFIRM_PATH
    : null;
}
