import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const COOKIE = "dne_preview";
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};
export function token(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : randomBytes(32).toString("hex");
}
export function csrf(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}
export function validCsrf(provided: unknown, value: string, secret: string) {
  if (typeof provided !== "string" || !/^[a-f0-9]{64}$/.test(provided))
    return false;
  return timingSafeEqual(
    Buffer.from(provided, "hex"),
    Buffer.from(csrf(value, secret), "hex"),
  );
}
