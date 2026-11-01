export const browserOrigin =
  process.env.DNE_E2E_ORIGIN ?? "http://127.0.0.1:4317";
if (
  !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(browserOrigin) ||
  Number(new URL(browserOrigin).port) > 65535
)
  throw Error("Browser tests require an isolated loopback origin");
