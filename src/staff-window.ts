// Editable defaults for a finite staff access window (#596). The window
// starts now and lasts one day, never past the target credential's expiry.
// The server still validates whatever the administrator submits.
const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;

export function defaultWindow(maximum: Date | string, now = new Date()) {
  const end = Math.min(
    new Date(maximum).getTime(),
    now.getTime() + DEFAULT_DURATION_MS,
  );
  return {
    startsAt: now.toISOString(),
    expiresAt: new Date(end).toISOString(),
  };
}

// A start example in the accepted range: tomorrow, on the hour.
export function upcomingExample(now = new Date()) {
  const example = new Date(now.getTime() + DEFAULT_DURATION_MS);
  example.setUTCMinutes(0, 0, 0);
  return example.toISOString();
}
