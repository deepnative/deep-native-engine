import { createHash } from "node:crypto";
import {
  AI_SIMULATED_OUTPUT_TOKENS,
  aiInputTokens,
  type AiUsage,
} from "./ai-budget-policy.ts";

export const ADAPTER_KINDS = [
  "ai",
  "payment",
  "storage",
  "calendar",
  "email",
  "auth",
  "analytics",
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
export type ApplicationMode = "demo" | "test" | "live";
export type AdapterState = "simulated" | "configured" | "disabled";

export interface AdapterReadiness {
  kind: AdapterKind;
  requestedMode: ApplicationMode;
  state: AdapterState;
  message: string;
  missing: string[];
}

export interface AdapterResult {
  kind: AdapterKind;
  mode: "demo" | "test";
  state: "simulated";
  reference: string;
  message: string;
  // Untrusted AI usage. Only readAiUsage may read it; validation discards it.
  usage?: AiUsage;
}

// The runtime boundary accepts only data fields from the internal demo/test
// contract. References are opaque ASCII tokens (1–128 characters); messages
// are single-line visible text (1–240 characters). Extra fields are discarded.
export function validateAdapterResult(
  value: unknown,
  kind: AdapterKind,
  mode: ApplicationMode,
): AdapterResult | null {
  if (mode !== "demo" && mode !== "test") return null;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const field = (name: keyof AdapterResult): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const reference = field("reference");
    const message = field("message");
    if (
      field("kind") !== kind ||
      field("mode") !== mode ||
      field("state") !== "simulated" ||
      typeof reference !== "string" ||
      reference.trim() !== reference ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reference) ||
      typeof message !== "string" ||
      message.length < 1 ||
      message.length > 240 ||
      message.trim() !== message ||
      /\p{C}/u.test(message)
    )
      return null;
    return { kind, mode, state: "simulated", reference, message };
  } catch {
    return null;
  }
}

export interface Adapter {
  kind: AdapterKind;
  mode: ApplicationMode;
  execute(operation: string, input: unknown): Promise<AdapterResult>;
}

export interface AdapterRegistry {
  mode: "demo" | "test";
  adapter(kind: AdapterKind, requestedMode: ApplicationMode): Adapter;
}

const liveRequirements: Record<AdapterKind, string[]> = {
  ai: ["DNE_LIVE_AI_ENDPOINT", "DNE_LIVE_AI_API_KEY"],
  payment: ["DNE_LIVE_PAYMENT_ACCOUNT", "DNE_LIVE_PAYMENT_WEBHOOK_SECRET"],
  storage: ["DNE_LIVE_STORAGE_BUCKET", "DNE_LIVE_STORAGE_REGION"],
  calendar: ["DNE_LIVE_CALENDAR_ACCOUNT", "DNE_LIVE_CALENDAR_TOKEN"],
  email: ["DNE_LIVE_EMAIL_SENDER", "DNE_LIVE_EMAIL_API_KEY"],
  auth: ["DNE_LIVE_AUTH_ISSUER", "DNE_LIVE_AUTH_CLIENT_ID"],
  analytics: ["DNE_LIVE_ANALYTICS_ENDPOINT", "DNE_LIVE_ANALYTICS_WRITE_KEY"],
};

export function applicationMode(value: string | undefined): ApplicationMode {
  const mode = value ?? "demo";
  if (mode !== "demo" && mode !== "test" && mode !== "live")
    throw new Error("DNE_APP_MODE must be demo, test, or live.");
  return mode;
}

function adapterMode(
  value: string | undefined,
  fallback: ApplicationMode,
  kind: AdapterKind,
): ApplicationMode {
  if (value === undefined) return fallback;
  if (value !== "demo" && value !== "test" && value !== "live")
    throw new Error(
      `DNE_${kind.toUpperCase()}_MODE must be demo, test, or live.`,
    );
  return value;
}

export function demoImpersonation(
  value: string | undefined,
  mode: ApplicationMode,
) {
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error("DNE_DEMO_IMPERSONATION must be true or false.");
  const enabled = value === "true";
  if (enabled && mode === "live")
    throw new Error("Demo impersonation cannot run in live mode.");
  return enabled;
}

export function validateDatabaseIsolation(mode: ApplicationMode, url: URL) {
  const database = decodeURIComponent(url.pathname.slice(1));
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (mode === "demo" && (!loopback || !/^dne_(dev|demo)$/.test(database)))
    throw new Error(
      "Demo mode requires its loopback dne_dev or dne_demo database.",
    );
  if (
    mode === "test" &&
    (!loopback || !/^dne_test_[a-f0-9]{32}$/.test(database))
  )
    throw new Error("Test mode requires an isolated random dne_test database.");
  if (
    mode === "live" &&
    (loopback || /(^|_)(dev|demo|test)($|_)/.test(database))
  )
    throw new Error("Live mode requires a non-loopback live-only database.");
}

export function adapterReadiness(
  env: NodeJS.ProcessEnv,
  mode: ApplicationMode,
): AdapterReadiness[] {
  return ADAPTER_KINDS.map((kind) => {
    const requestedMode = adapterMode(
      env[`DNE_${kind.toUpperCase()}_MODE`],
      mode,
      kind,
    );
    if (requestedMode !== mode)
      return {
        kind,
        requestedMode,
        state: "disabled",
        message: `${requestedMode} ${kind} is disabled in ${mode} application mode.`,
        missing: [],
      };
    if (mode !== "live")
      return {
        kind,
        requestedMode,
        state: "simulated",
        message: `${kind} uses a deterministic ${mode} adapter; no external side effect occurs.`,
        missing: [],
      };
    const missing = liveRequirements[kind].filter((name) => !env[name]?.trim());
    const unsafeBucket =
      kind === "storage" &&
      /^(demo|test)[-_]/i.test(env.DNE_LIVE_STORAGE_BUCKET ?? "");
    if (missing.length || unsafeBucket)
      return {
        kind,
        requestedMode,
        state: "disabled",
        message: unsafeBucket
          ? "Use a live-only storage bucket, not a demo/test bucket."
          : `Configure ${missing.join(", ")} before enabling live ${kind}.`,
        missing,
      };
    return {
      kind,
      requestedMode,
      state: "configured",
      message: `Live ${kind} settings are present; provider verification remains required.`,
      missing: [],
    };
  });
}

function simulatedAiUsage(kind: AdapterKind, input: unknown) {
  if (kind !== "ai" || typeof input !== "object" || input === null) return {};
  const text = (input as { text?: unknown }).text;
  if (typeof text !== "string") return {};
  return {
    usage: {
      inputTokens: aiInputTokens(Buffer.byteLength(text)),
      outputTokens: AI_SIMULATED_OUTPUT_TOKENS,
    },
  };
}

export function deterministicAdapter(
  kind: AdapterKind,
  mode: "demo" | "test",
): Adapter {
  return {
    kind,
    mode,
    async execute(operation, input) {
      const normalized = operation.trim();
      if (!normalized || normalized.length > 80)
        throw new Error(
          "Adapter operation must be between 1 and 80 characters.",
        );
      const reference = createHash("sha256")
        .update(JSON.stringify([kind, mode, normalized, input]))
        .digest("hex")
        .slice(0, 24);
      return {
        kind,
        mode,
        state: "simulated",
        reference: `${mode}_${reference}`,
        message: `Simulated ${kind} ${normalized}; no external side effect occurred.`,
        ...simulatedAiUsage(kind, input),
      };
    },
  };
}

export const TEST_AI_FAULT_MARKERS = {
  timeout: "[dne-test-fault:timeout]",
  malformed: "[dne-test-fault:malformed]",
} as const;

/** #190 AIFAULT: off unless set, only in test mode and never on a host. */
export function testAiFaults(
  env: NodeJS.ProcessEnv,
  mode: ApplicationMode,
  hosted: boolean,
): boolean {
  const value = env.DNE_TEST_AI_FAULTS ?? "disabled";
  if (value !== "enabled" && value !== "disabled")
    throw new Error("DNE_TEST_AI_FAULTS must be enabled or disabled.");
  if (value === "disabled") return false;
  if (mode !== "test" || hosted)
    throw new Error("Test AI faults run only in local test mode.");
  return true;
}

// Invented text carrying a marker makes the simulated AI step never answer or
// answer in an unexpected form, so browser tests can reach those paths.
function faultingAdapter(adapter: Adapter): Adapter {
  return {
    ...adapter,
    async execute(operation, input) {
      const text =
        typeof input === "object" && input !== null
          ? (input as { text?: unknown }).text
          : undefined;
      if (typeof text === "string") {
        if (text.includes(TEST_AI_FAULT_MARKERS.timeout))
          return new Promise<never>(() => {});
        if (text.includes(TEST_AI_FAULT_MARKERS.malformed))
          return { ...(await adapter.execute(operation, input)), message: "" };
      }
      return adapter.execute(operation, input);
    },
  };
}

export function deterministicRegistry(
  env: NodeJS.ProcessEnv,
  mode: "demo" | "test",
  options: { aiFaults?: boolean } = {},
): AdapterRegistry {
  const enabled = new Map(
    adapterReadiness(env, mode).map((readiness) => [readiness.kind, readiness]),
  );
  return {
    mode,
    adapter(kind, requestedMode) {
      const readiness = enabled.get(kind);
      if (requestedMode !== mode)
        throw new Error(
          `${kind} ${requestedMode} execution is disabled in ${mode} application mode.`,
        );
      if (!readiness || readiness.state !== "simulated")
        throw new Error(
          `${kind} execution is disabled in ${mode} application mode.`,
        );
      const adapter = deterministicAdapter(kind, mode);
      return options.aiFaults && kind === "ai" && mode === "test"
        ? faultingAdapter(adapter)
        : adapter;
    },
  };
}
