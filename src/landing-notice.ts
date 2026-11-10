import type { Request, Response } from "express";
import { cookieOptions } from "./session.ts";

/** FRICTION-02/05: one short explanation shown the next time the home page opens. */
export type LandingNotice =
  | "deleted"
  | "signed-out"
  // RETEXP-02 (#12 D08): deleted, with the date the kept invoices are removed.
  | `deleted-until-${string}`;
const COOKIE = "dne_landing_notice";

function options(origin: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: cookieOptions(origin).secure,
  };
}
export function setLandingNotice(
  res: Response,
  notice: LandingNotice,
  origin: string,
) {
  res.cookie(COOKIE, notice, { ...options(origin), maxAge: 60_000 });
}
/** Reads and clears the notice. Any other cookie value shows nothing. */
export function takeLandingNotice(
  req: Request,
  res: Response,
  origin: string,
): LandingNotice | undefined {
  const value: unknown = (req.cookies as Record<string, unknown>)[COOKIE];
  if (value === undefined) return undefined;
  res.clearCookie(COOKIE, options(origin));
  return value === "deleted" ||
    value === "signed-out" ||
    (typeof value === "string" &&
      /^deleted-until-2[01][0-9]{2}-12-31$/.test(value))
    ? (value as LandingNotice)
    : undefined;
}
