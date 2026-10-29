import { createHash } from "node:crypto";
import { FOUNDATION_PACK } from "./foundation-pack.ts";

export const PROGRAM_PATH = "/programs/foundation/terms/local-foundation-1";
export const PROGRAM_CONFIRM_PATH = `${PROGRAM_PATH}/confirm`;
export const PROGRAM_MANIFEST = {
  programId: "foundation",
  programVersion: 1,
  termId: "local-foundation-1",
  termVersion: 1,
  title: "Applied AI foundations",
  capacity: 20,
  simulation: true,
  lessons: FOUNDATION_PACK.map(([id, , sourceDigest], index) => ({
    id,
    version: 2,
    sourceDigest,
    outcome: [
      "Choose a useful task and distinguish a claim from evidence.",
      "Write a clear request with context and a checkable result.",
      "Check an output against its sources and explain a correction.",
      "Choose what is safe and permitted to share.",
      "Describe and check a repeatable practical workflow.",
      "Ask for useful feedback and choose what to contribute.",
    ][index]!,
  })),
};
export const PROGRAM_DIGEST = createHash("sha256")
  .update(JSON.stringify(PROGRAM_MANIFEST))
  .digest("hex");
export type ProgramManifest = typeof PROGRAM_MANIFEST;
export type ProgramState = "not_open" | "open" | "closed";
export type ProgramAvailability =
  ProgramState | "full" | "ready" | "course_unavailable";
export interface ProgramIntent {
  programVersion: number;
  termVersion: number;
  digest: string;
  revision: number;
}
export interface ProgramOverview {
  manifest: ProgramManifest;
  digest: string;
  revision: number;
  state: ProgramState;
  availability: ProgramAvailability;
  remaining: number;
  lessons: Array<{ id: string; version: number; title: string }>;
}
export interface ProgramReceipt {
  id: string;
  enrolledAt: string;
  manifest: ProgramManifest;
  digest: string;
  activity: Array<{
    id: string;
    version: number;
    started: boolean;
    selfAssessed: boolean;
  }>;
}
export function publicProgramReceipt(receipt: ProgramReceipt) {
  return {
    id: receipt.id,
    enrolledAt: receipt.enrolledAt,
    manifest: {
      programId: receipt.manifest.programId,
      programVersion: receipt.manifest.programVersion,
      termId: receipt.manifest.termId,
      termVersion: receipt.manifest.termVersion,
      title: receipt.manifest.title,
      lessons: receipt.manifest.lessons.map(({ id, version, outcome }) => ({
        id,
        version,
        outcome,
      })),
    },
    digest: receipt.digest,
    activity: receipt.activity.map(
      ({ id, version, started, selfAssessed }) => ({
        id,
        version,
        started,
        selfAssessed,
      }),
    ),
  };
}
export type ProgramResult<T> =
  | { kind: "ready"; value: T }
  | {
      kind:
        | "denied"
        | "invalid"
        | "conflict"
        | "stale"
        | "full"
        | "closed"
        | "unavailable";
    };
export interface ProgramStore {
  overview(): Promise<ProgramResult<ProgramOverview>>;
  admin(token: string): Promise<ProgramResult<ProgramOverview>>;
  change(
    token: string,
    action: "open" | "close",
    revision: number,
    digest: string,
  ): Promise<ProgramResult<ProgramOverview>>;
  enroll(
    token: string,
    key: string,
    intent: ProgramIntent,
  ): Promise<ProgramResult<ProgramReceipt>>;
  mine(token: string): Promise<ProgramResult<ProgramReceipt | null>>;
  inspect(
    token: string,
    key: string,
  ): Promise<ProgramResult<ProgramReceipt | null>>;
}
export const programKey = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
export function programIntent(value: unknown): ProgramIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const integer = (x: unknown) =>
    (typeof x === "string" && /^[1-9][0-9]{0,8}$/.test(x)) ||
    (typeof x === "number" && Number.isSafeInteger(x) && x > 0);
  if (
    !integer(v.programVersion) ||
    !integer(v.termVersion) ||
    !integer(v.revision) ||
    typeof v.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.digest)
  )
    return null;
  return {
    programVersion: Number(v.programVersion),
    termVersion: Number(v.termVersion),
    revision: Number(v.revision),
    digest: v.digest,
  };
}
export function disabledProgramStore(): ProgramStore {
  const unavailable = async () => ({ kind: "unavailable" }) as const;
  return {
    overview: unavailable,
    admin: unavailable,
    change: unavailable,
    enroll: unavailable,
    mine: unavailable,
    inspect: unavailable,
  };
}
