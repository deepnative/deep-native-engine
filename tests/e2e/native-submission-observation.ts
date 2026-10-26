import type { Page, TestInfo } from "@playwright/test";

const eventTypes = [
  "keydown",
  "keypress",
  "keyup",
  "click",
  "submit",
  "invalid",
  "focusin",
  "focusout",
] as const;
const tags = [
  "INPUT",
  "BUTTON",
  "FORM",
  "BODY",
  "HTML",
  "A",
  "TEXTAREA",
  "SELECT",
  "LABEL",
];
const inputTypes = ["checkbox", "submit", "text", "hidden", "button"];
const binding = "__dneNativeSubmissionObservation";
const deliveryFlag = "__dneNativeSubmissionDeliveryFailed";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function choice(value: unknown, choices: readonly string[]) {
  return typeof value === "string" && choices.includes(value) ? value : null;
}
function flag(value: unknown) {
  return typeof value === "boolean" ? value : null;
}
function instant(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}
function element(value: unknown) {
  const row = object(value);
  return {
    tag: choice(row.tag, tags) ?? "OTHER",
    type: choice(row.type, inputTypes),
  };
}
function route(value: string) {
  try {
    if (value.length > 2048) return "other";
    const path = new URL(value).pathname;
    if (path === "/lesson") return "lesson";
    if (/^\/exercise\/clear-instructions\/[1-9][0-9]*\/withdraw$/.test(path))
      return "withdrawal";
  } catch {
    /* Never retain arbitrary URLs or parser error details. */
  }
  return "other";
}

/** Shape-only evidence: no form values, text, arbitrary attributes or URLs. */
export function nativeSubmissionCollector() {
  const events: unknown[] = [];
  let bytes = 0,
    truncated = false,
    discarded = 0;
  let lastObservedState: unknown = null,
    captureFailed = false;
  function append(event: unknown) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    // Reserve room for schema, final state and explicit observation limits.
    if (events.length >= 256 || bytes + size > 60 * 1024) {
      truncated = true;
      return;
    }
    events.push(event);
    bytes += size;
  }
  return {
    native(value: unknown) {
      const row = object(value),
        type = choice(row.type, eventTypes);
      if (!type) {
        discarded++;
        return;
      }
      lastObservedState = {
        active: element(row.active),
        hasFocus: flag(row.hasFocus),
        formValid: flag(row.formValid),
        document: instant(row.document),
        at: instant(row.at),
      };
      if (row.deliveryFailed === true) captureFailed = true;
      append({
        kind: "native",
        type,
        phase: choice(row.phase, ["capture", "microtask"]),
        key: choice(row.key, ["Enter", "Tab", " ", "Spacebar"]),
        target: element(row.target),
        active: element(row.active),
        document: instant(row.document),
        at: instant(row.at),
        trusted: flag(row.trusted),
        hasFocus: flag(row.hasFocus),
        defaultPrevented: flag(row.defaultPrevented),
        formValid: flag(row.formValid),
        withdrawalForm: flag(row.withdrawalForm),
        deliveryFailed: flag(row.deliveryFailed),
      });
    },
    request(method: string, url: string, status?: number) {
      append({
        kind: status === undefined ? "request" : "response",
        method: choice(method, ["GET", "POST"]) ?? "other",
        route: route(url),
        status:
          Number.isInteger(status) && status! >= 100 && status! <= 599
            ? status
            : null,
      });
    },
    captureFailed() {
      captureFailed = true;
    },
    evidence() {
      return {
        schema: "native-submission-observation-v1",
        events,
        lastObservedState,
        truncated,
        discarded,
        captureFailed,
        navigationDeliveryGuaranteed: false,
        limits:
          "Observation can affect timing. Cancellation flags are samples, not guaranteed final dispatch state. Binding messages may be lost across navigation; missing native events do not prove that no event occurred. No historical cause inferred from a passing run.",
      };
    },
  };
}

export async function attachNativeSubmissionFailure(
  info: Pick<TestInfo, "status" | "expectedStatus" | "attach">,
  collector: ReturnType<typeof nativeSubmissionCollector>,
) {
  if (info.status === info.expectedStatus) return;
  await info.attach("native-submission-observation", {
    body: Buffer.from(JSON.stringify(collector.evidence())),
    contentType: "application/json",
  });
}

/** Observe existing input; never focus, dispatch, validate, cancel or submit. */
export async function observeNativeSubmission(page: Page) {
  const collector = nativeSubmissionCollector();
  const context = page.context();
  await context.exposeBinding(binding, (_source, event: unknown) =>
    collector.native(event),
  );
  await context.addInitScript(
    ({ binding, deliveryFlag, tags, inputTypes }) => {
      const globals = globalThis as unknown as Record<string, unknown>;
      globals[deliveryFlag] = false;
      const describe = (value: EventTarget | null) => {
        const type =
          value instanceof Element ? value.getAttribute("type") : null;
        return {
          tag:
            value instanceof Element && tags.includes(value.tagName)
              ? value.tagName
              : "OTHER",
          type: type && inputTypes.includes(type) ? type : null,
        };
      };
      const send = (value: unknown) => {
        const emit = globals[binding] as (value: unknown) => Promise<void>;
        void emit(value).catch(() => {
          globals[deliveryFlag] = true;
        });
      };
      for (const type of [
        "keydown",
        "keypress",
        "keyup",
        "click",
        "submit",
        "invalid",
        "focusin",
        "focusout",
      ]) {
        document.addEventListener(
          type,
          (event) => {
            if (
              location.pathname !== "/lesson" ||
              !new URL(location.href).searchParams.has("version")
            )
              return;
            const form =
              event.target instanceof Element
                ? event.target.closest("form")
                : null;
            const row = {
              type,
              phase: "capture",
              key:
                event instanceof KeyboardEvent &&
                ["Enter", "Tab", " ", "Spacebar"].includes(event.key)
                  ? event.key
                  : null,
              target: describe(event.target),
              active: describe(document.activeElement),
              document: performance.timeOrigin,
              at: performance.now(),
              trusted: event.isTrusted,
              hasFocus: document.hasFocus(),
              defaultPrevented: event.defaultPrevented,
              deliveryFailed: globals[deliveryFlag] === true,
              formValid: form
                ? [...form.elements].every(
                    (el) =>
                      !(el as HTMLInputElement).willValidate ||
                      (el as HTMLInputElement).validity.valid,
                  )
                : null,
              withdrawalForm: form
                ? /^\/exercise\/clear-instructions\/[1-9][0-9]*\/withdraw$/.test(
                    new URL(form.action).pathname,
                  )
                : null,
            };
            send(row);
            queueMicrotask(() =>
              send({
                ...row,
                phase: "microtask",
                active: describe(document.activeElement),
                hasFocus: document.hasFocus(),
                defaultPrevented: event.defaultPrevented,
              }),
            );
          },
          true,
        );
      }
    },
    { binding, deliveryFlag, tags, inputTypes },
  );
  page.on("request", (request) =>
    collector.request(request.method(), request.url()),
  );
  page.on("response", (response) =>
    collector.request(
      response.request().method(),
      response.url(),
      response.status(),
    ),
  );
  return {
    collector,
    async finish(info: Pick<TestInfo, "status" | "expectedStatus" | "attach">) {
      // Already-delivered metadata stays available even if the renderer stalls.
      await attachNativeSubmissionFailure(info, collector);
    },
  };
}
