import { expect, it } from "vitest";
import {
  uniqueCookie,
  staffCookie,
  staffFamily,
  selectedStaffToken,
  STAFF_COOKIE,
  ENTRY_COOKIE,
  SIGNED_OUT,
  staffCredential,
} from "../../src/staff-entry-selection.ts";
const a = "a".repeat(64),
  b = "b".repeat(64);
it("STAFF-03-AMBIGUITY rejects equal/conflicting duplicates, malformed encoding, empty and malformed explicit authority", () => {
  for (const name of [STAFF_COOKIE, ENTRY_COOKIE]) {
    expect(uniqueCookie(undefined, name)).toEqual({ kind: "absent" });
    expect(uniqueCookie(`unrelated=a; ${name}=${a}`, name)).toEqual({
      kind: "value",
      value: a,
    });
    for (const raw of [
      `${name}=${a}; ${name}=${a}`,
      `${name}=${a}; ${name}=${b}`,
      `${name}`,
      `${name}=`,
      `${name}=%zz`,
      `${name} =${a}`,
      `${name}=${a}; ${name} =${b}`,
    ])
      expect(uniqueCookie(raw, name)).toEqual({ kind: "invalid" });
  }
  expect(staffCookie(`${STAFF_COOKIE}=not-a-credential`)).toEqual({
    kind: "invalid",
  });
  expect(staffCookie(`${STAFF_COOKIE}=${SIGNED_OUT}`)).toEqual({
    kind: "value",
    value: SIGNED_OUT,
  });
  expect(staffCredential(null)).toBe(false);
});
it("STAFF-05-ROUTES selects actual case-insensitive non-strict staff families before mutation CSRF", () => {
  for (const path of [
    "/editor",
    "/EDITOR/library/",
    "/review/worklist",
    "/REVIEW/worklist/",
    "/operator/support",
    "/OPERATOR/support/",
    "/moderate/proposals/",
  ]) {
    expect(staffFamily(path)).toBe(true);
    expect(selectedStaffToken(path, `${STAFF_COOKIE}=${b}`, a, true)).toBe(b);
    expect(selectedStaffToken(path, undefined, a, true)).toBe(a);
    expect(
      selectedStaffToken(path, `${STAFF_COOKIE}=${SIGNED_OUT}`, a, true),
    ).toBeNull();
    expect(selectedStaffToken(path, `${STAFF_COOKIE}=bad`, a, true)).toBeNull();
    expect(
      selectedStaffToken(
        path,
        `${STAFF_COOKIE}=${a}; ${STAFF_COOKIE}=${b}`,
        a,
        true,
      ),
    ).toBeNull();
  }
});
it("STAFF-05-MEMBER STAFF-05-MIXED preserve member and mixed API actors and disabled legacy semantics", () => {
  for (const path of [
    "/review-minutes",
    "/editorial",
    "/operatorx",
    "/moderate-other",
    "/learn",
    "/progress",
    "/member/export",
    "/api/workspaces/id/private",
    "/api/evidence/id/download-link",
    "/api/evidence/id/download",
  ]) {
    expect(staffFamily(path)).toBe(false);
    expect(selectedStaffToken(path, `${STAFF_COOKIE}=${b}`, a, true)).toBe(a);
    expect(selectedStaffToken(path, `${STAFF_COOKIE}=bad`, a, true)).toBe(a);
  }
  expect(
    selectedStaffToken(
      "/editor/library",
      `${STAFF_COOKIE}=${SIGNED_OUT}`,
      a,
      false,
    ),
  ).toBe(a);
});
