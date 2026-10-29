import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import {
  PROGRAM_SELECTION_COOKIE,
  PROGRAM_SELECTION_MS,
  issueProgramSelection,
  programResumeTarget,
  readProgramSelection,
} from "../../src/program-selection.ts";
import { PROGRAM_CONFIRM_PATH } from "../../src/program-values.ts";

const secret = "invented-public-selection-secret";
const now = 1000000;
const cookie = (value: string) => `${PROGRAM_SELECTION_COOKIE}=${value}`;
it("PROGRAM-15/ENR-06 resumes only the signed exact public choice for its bounded lifetime", () => {
  const value = issueProgramSelection(secret, now);
  expect(readProgramSelection(cookie(value), secret, now)).toBe("ready");
  expect(
    readProgramSelection(cookie(value), secret, now + PROGRAM_SELECTION_MS - 1),
  ).toBe("ready");
  expect(
    readProgramSelection(cookie(value), secret, now + PROGRAM_SELECTION_MS),
  ).toBe("invalid");
  expect(readProgramSelection(cookie(value), secret, now - 1)).toBe("invalid");
  expect(readProgramSelection(cookie(value), "another-secret", now)).toBe(
    "invalid",
  );
  expect(
    programResumeTarget(cookie(issueProgramSelection(secret)), secret),
  ).toBe(PROGRAM_CONFIRM_PATH);
  expect(programResumeTarget(undefined, secret)).toBeNull();
  expect(readProgramSelection(undefined, secret, now)).toBe("absent");
  expect(readProgramSelection("unrelated=anything", secret, now)).toBe(
    "absent",
  );
});
it.each([
  "",
  "%zz",
  "x".repeat(1025),
  "payload.signature",
  "a." + "0".repeat(64),
  "a." + "0".repeat(64) + ".extra",
  "#." + "0".repeat(64),
])("PROGRAM-15/ENR-06 rejects malformed continuation %s", (value) => {
  expect(readProgramSelection(cookie(value), secret, now)).toBe("invalid");
});
it("PROGRAM-15/ENR-06 refuses duplicate, changed, unsupported and extra selection fields", () => {
  const good = issueProgramSelection(secret, now);
  expect(
    readProgramSelection(`${cookie(good)}; ${cookie(good)}`, secret, now),
  ).toBe("invalid");
  expect(
    readProgramSelection(
      cookie(good.slice(0, -1) + (good.endsWith("a") ? "b" : "a")),
      secret,
      now,
    ),
  ).toBe("invalid");
  const original = JSON.parse(
    Buffer.from(good.split(".")[0]!, "base64url").toString(),
  );
  const sign = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    const digest = createHmac("sha256", secret)
      .update(`program-selection-v1:${payload}`)
      .digest("hex");
    return `${payload}.${digest}`;
  };
  for (const changed of [
    null,
    [],
    { ...original, programId: "another-program" },
    { ...original, programVersion: 2 },
    { ...original, termId: "another-term" },
    { ...original, termVersion: 2 },
    { ...original, digest: "0".repeat(64) },
    { ...original, expires: now + PROGRAM_SELECTION_MS + 1 },
    { ...original, expires: "later" },
    { ...original, returnTo: "https://example.invalid/" },
  ])
    expect(readProgramSelection(cookie(sign(changed)), secret, now)).toBe(
      "invalid",
    );
  const malformed = Buffer.from("{").toString("base64url");
  const digest = createHmac("sha256", secret)
    .update(`program-selection-v1:${malformed}`)
    .digest("hex");
  expect(
    readProgramSelection(cookie(`${malformed}.${digest}`), secret, now),
  ).toBe("invalid");
});
