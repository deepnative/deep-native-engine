// #12 D01/D02, owner decisions of 9 November 2026: Deep Native Inc. in
// Ontario, Canada operates the service, and it is offered to people living in
// Canada first. A fixed constant, not a host setting, so a new market needs a
// new reviewed decision and a code change. Terms, privacy and retention text
// still need qualified review; nothing here says they are accepted.
export const SERVICE_OPERATOR = "Deep Native Inc.";
export const SERVICE_OPERATOR_PLACE = "Ontario, Canada";
export const CUSTOMER_COUNTRIES = [{ code: "CA", name: "Canada" }] as const;
export const OPERATOR_STATEMENT = `Deep Native Engine is operated by ${SERVICE_OPERATOR} in ${SERVICE_OPERATOR_PLACE}, and is offered to people living in Canada for now.`;
export const OUTSIDE_MARKET_MESSAGE =
  "Country where you live: Deep Native Engine is only offered to people living in Canada for now. Nothing was saved.";

/** Only an exact allowlisted code counts; anything else is refused. */
export function servedCountry(value: unknown): boolean {
  return CUSTOMER_COUNTRIES.some((country) => country.code === value);
}
