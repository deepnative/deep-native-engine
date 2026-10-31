const prefix = "/api/learning-workspace";
const variants = ["everyday", "work", "technical"];
const failureKinds = new Set([
  "denied",
  "unavailable",
  "invalid",
  "conflict",
  "deleted",
  "source-unavailable",
  "not-found",
]);
const success = (value) =>
  value?.kind === "saved" || value?.kind === "replayed";
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function createLearningWorkspaceStorage({
  fetch,
  csrf,
  randomUUID,
  identity,
  emptyState,
  feedbackCases,
}) {
  const notebooks = new Map();
  const plans = new Map();
  const token = () => (typeof csrf === "function" ? csrf() : csrf);
  const routeIdentity = (route) => ({ ...identity, variant: route });
  const initialHead = (route) => ({
    sequence: 0,
    artifact: { ...feedbackCases[route].versions.at(-1) },
  });
  const validRoute = (route) => variants.includes(route);
  const path = (id) => `${prefix}/notebooks/${encodeURIComponent(id)}`;

  async function request(method, url, body) {
    try {
      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "x-csrf-token": token(),
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!value || typeof value !== "object" || typeof value.kind !== "string")
        return { kind: "transport-error" };
      if (!response.ok)
        return failureKinds.has(value.kind)
          ? value
          : {
              kind:
                response.status === 401 || response.status === 403
                  ? "denied"
                  : "transport-error",
            };
      return value;
    } catch {
      return { kind: "transport-error" };
    }
  }

  function mutationFailure(result, plan) {
    const kind =
      result.kind === "transport-error" || result.kind === "unavailable"
        ? "unconfirmed"
        : result.kind === "conflict" || result.kind === "denied"
          ? result.kind
          : result.kind === "deleted" || result.kind === "not-found"
            ? "denied"
            : "unavailable";
    plan.uncertain = kind === "unconfirmed";
    return {
      kind,
      confirmedDecisionCount: plan.confirmed,
      feedbackHead: plan.head,
    };
  }

  function applyReceipt(plan, result) {
    if (
      !success(result) ||
      !result.notebookId ||
      !integer(result.revision) ||
      !integer(result.decisionSequence)
    )
      return false;
    if (plan.stage === "create") {
      if (result.decisionSequence !== 0 || result.revision !== 1) return false;
      plan.notebookId = result.notebookId;
      plan.revision = result.revision;
      plan.stage = "decision";
    } else if (plan.stage === "decision") {
      const decision = plan.decisions[plan.confirmed];
      if (
        result.notebookId !== plan.notebookId ||
        result.decisionSequence !== decision.id
      )
        return false;
      plan.revision = result.revision;
      plan.confirmed += 1;
      plan.head = {
        sequence: decision.id,
        artifact: { id: decision.toVersion, text: decision.text },
      };
    } else {
      if (
        result.notebookId !== plan.notebookId ||
        result.decisionSequence !== plan.head.sequence
      )
        return false;
      plan.revision = result.revision;
      plan.stage = "done";
    }
    notebooks.set(plan.route, {
      id: plan.notebookId,
      revision: plan.revision,
      head: plan.head,
      savedDraftRevision:
        plan.stage === "done" ? plan.revision : plan.savedDraftRevision,
    });
    plan.uncertain = false;
    return true;
  }

  async function checkReceipt(plan) {
    if (plan.stage === "decision" && plan.confirmed === plan.decisions.length)
      plan.stage = "draft";
    const id =
      plan.stage === "create"
        ? plan.createOp
        : plan.stage === "decision"
          ? plan.decisionOps[plan.confirmed]
          : plan.draftOp;
    const result = await request(
      "GET",
      `${prefix}/operations/${encodeURIComponent(id)}`,
    );
    if (!success(result)) return result;
    return applyReceipt(plan, result)
      ? { kind: "confirmed" }
      : { kind: plan.stage === "create" ? "conflict" : "transport-error" };
  }

  function saved(plan) {
    plans.delete(`${plan.route}:${plan.operationId}`);
    return {
      kind: "saved",
      revision: plan.revision,
      savedDraftRevision: plan.revision,
      feedbackHead: plan.head,
      confirmedDecisionCount: plan.confirmed,
    };
  }

  async function historyPage(route, before) {
    const notebook = notebooks.get(route);
    if (!notebook?.id || before <= 1) return { items: [], nextCursor: null };
    const after = Math.max(0, before - 21);
    const result = await request(
      "GET",
      `${path(notebook.id)}/history?after=${after}`,
    );
    if (result.kind !== "ok" || !Array.isArray(result.value?.items))
      throw new Error("Learning history unavailable");
    const items = result.value.items.filter(
      (item) => integer(item.id) && item.id < before,
    );
    if (
      items.length !== before - after - 1 ||
      items.some((item, index) => item.id !== after + index + 1)
    )
      throw new Error("Learning history incomplete");
    return { items, nextCursor: items[0]?.id > 1 ? String(items[0].id) : null };
  }

  return {
    mode: "account",
    async load(route) {
      if (!validRoute(route)) return { kind: "invalid" };
      const result = await request("GET", `${prefix}/current?variant=${route}`);
      if (result.kind === "empty") {
        notebooks.set(route, {
          id: null,
          revision: null,
          head: initialHead(route),
          savedDraftRevision: null,
        });
        return {
          kind: "ready",
          state: emptyState(route),
          notebookId: null,
          revision: null,
          savedDraftRevision: null,
          feedbackHead: initialHead(route),
          feedbackHistoryPage: { items: [], nextCursor: null },
        };
      }
      const value = result.value;
      if (
        result.kind !== "ok" ||
        !value ||
        value.availability !== "available" ||
        value.variant !== route ||
        value.contentId !== identity.contentId ||
        value.contentVersion !== identity.contentVersion ||
        value.contentHash !== identity.contentHash ||
        !value.id ||
        !integer(value.revision) ||
        !integer(value.draftRevision) ||
        !integer(value.decisionSequence) ||
        !value.state
      )
        return {
          kind: failureKinds.has(result.kind) ? result.kind : "unavailable",
        };
      const head = {
        sequence: value.decisionSequence,
        artifact: value.currentArtifact ?? initialHead(route).artifact,
      };
      if (head.sequence && !value.currentArtifact)
        return { kind: "unavailable" };
      notebooks.set(route, {
        id: value.id,
        revision: value.revision,
        head,
        savedDraftRevision: value.draftRevision,
      });
      try {
        const page = await historyPage(route, head.sequence + 1);
        const state = globalThis.structuredClone(value.state);
        state.feedback.records = [];
        state.feedback.base = head;
        return {
          kind: "ready",
          state,
          notebookId: value.id,
          revision: value.revision,
          savedDraftRevision: value.draftRevision,
          feedbackHead: head,
          feedbackHistoryPage: page,
        };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async save(captured) {
      const { route, operationId } = captured;
      const notebook = notebooks.get(route);
      if (!validRoute(route) || !notebook || typeof operationId !== "string")
        return { kind: "unavailable", confirmedDecisionCount: 0 };
      const key = `${route}:${operationId}`;
      let plan = plans.get(key);
      if (!plan) {
        const decisions = globalThis.structuredClone(
          captured.capturedFeedbackDecisions ?? [],
        );
        plan = {
          route,
          operationId,
          decisions,
          decisionOps: decisions.map(() => randomUUID()),
          createOp: notebook.id ? null : randomUUID(),
          draftOp: randomUUID(),
          notebookId: notebook.id,
          revision: captured.expectedRevision,
          savedDraftRevision: notebook.savedDraftRevision,
          head: notebook.head,
          confirmed: 0,
          stage: notebook.id ? "decision" : "create",
          state: globalThis.structuredClone(captured.immutableState),
        };
        delete plan.state.feedback.records;
        delete plan.state.feedback.base;
        plans.set(key, plan);
      }
      while (plan.stage !== "done") {
        if (
          plan.stage === "decision" &&
          plan.confirmed === plan.decisions.length
        )
          plan.stage = "draft";
        if (plan.uncertain) {
          const checked = await checkReceipt(plan);
          if (checked.kind === "confirmed") continue;
          if (checked.kind !== "not-found")
            return mutationFailure(
              checked.kind === "denied" ||
                checked.kind === "deleted" ||
                checked.kind === "conflict"
                ? checked
                : { kind: "transport-error" },
              plan,
            );
        }
        let result;
        if (plan.stage === "create")
          result = await request("POST", `${prefix}/notebooks`, {
            ...routeIdentity(route),
            operationId: plan.createOp,
          });
        else if (plan.stage === "decision")
          result = await request(
            "POST",
            `${path(plan.notebookId)}/feedback-decisions`,
            {
              operationId: plan.decisionOps[plan.confirmed],
              expectedRevision: plan.revision,
              decision: plan.decisions[plan.confirmed],
            },
          );
        else
          result = await request("PUT", `${path(plan.notebookId)}/draft`, {
            operationId: plan.draftOp,
            expectedRevision: plan.revision,
            state: plan.state,
            basedOnDecisionSequence: plan.head.sequence,
          });
        if (!success(result)) return mutationFailure(result, plan);
        if (!applyReceipt(plan, result))
          return mutationFailure(
            { kind: plan.stage === "create" ? "conflict" : "transport-error" },
            plan,
          );
      }
      return saved(plan);
    },
    async inspect({ route, operationId }) {
      const plan = plans.get(`${route}:${operationId}`);
      if (!plan) return { kind: "not-confirmed" };
      const result = await checkReceipt(plan);
      if (result.kind !== "confirmed") return { kind: "not-confirmed" };
      return plan.stage === "done" ? saved(plan) : { kind: "not-confirmed" };
    },
    async history(route, cursor) {
      if (!validRoute(route) || !notebooks.has(route))
        throw new Error("Learning history unavailable");
      const before = Number(cursor);
      if (!integer(before) || before < 1)
        throw new Error("Learning history unavailable");
      return historyPage(route, before);
    },
    async download({
      route,
      state,
      pendingRecords,
      feedbackHead,
      historyPage,
    }) {
      if (
        !validRoute(route) ||
        !feedbackHead ||
        !integer(feedbackHead.sequence)
      )
        throw new Error("Learning history unavailable");
      const notebook = notebooks.get(route);
      const history = [];
      let after = 0;
      let complete = true;
      try {
        while (after < feedbackHead.sequence) {
          if (!notebook?.id) throw new Error("Learning history unavailable");
          const result = await request(
            "GET",
            `${path(notebook.id)}/history?after=${after}`,
          );
          if (result.kind !== "ok" || !Array.isArray(result.value?.items))
            throw new Error("Learning history unavailable");
          const page = result.value.items.filter(
            (item) => item.id <= feedbackHead.sequence,
          );
          if (
            !page.length ||
            page.some((item, index) => item.id !== after + index + 1)
          )
            throw new Error("Learning history incomplete");
          history.push(...page);
          after = page.at(-1).id;
          if (
            after < feedbackHead.sequence &&
            result.value.nextSequence !== after
          )
            throw new Error("Learning history incomplete");
        }
      } catch {
        complete = false;
      }
      return {
        text: JSON.stringify(
          {
            format: "deep-native-learning-workspace-1",
            identity: routeIdentity(route),
            savedHistory: history,
            savedHistoryComplete: complete,
            ...(complete
              ? {}
              : {
                  errorStatus: "saved-history-unavailable",
                  note: "Local rescue copy. Saved feedback history could not be verified; this is not a complete account export.",
                  availableHistoryPage: Array.isArray(historyPage?.items)
                    ? historyPage.items
                    : [],
                }),
            feedbackHead,
            pendingRecords,
            unsavedState: state,
          },
          null,
          2,
        ),
        filename: `foundation-${route}${complete ? "" : "-local-rescue"}.json`,
        mimeType: "application/json;charset=utf-8",
      };
    },
  };
}
