import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  CIRCLE_DISCUSSION_POLICY,
  REPORT_CATEGORIES,
  type CircleDiscussionStore,
  type CircleItem,
  type CirclePage,
  type CircleResult,
} from "./circle-discussion.ts";
import { escape, hidden, page } from "./views.ts";

const warning = `<p class="eyebrow">INVENTED LOCAL CIRCLE · UNREVIEWED</p><p>Share invented examples only. No private exercise or evidence is copied here. This sandbox has no staffed moderation, response-time promise, qualified review, AI provider or payment service.</p>`;
const base = (circle: string) =>
  `/circles/${encodeURIComponent(circle)}/discussion`;
function shell(circle: string, title: string, body: string) {
  const url = base(circle);
  return page(
    title,
    `<nav class="breadcrumb circle-discussion-nav"><a href="/circles">Local circles</a> · <a href="${url}">Questions</a> · <a href="${url}/owned">Your contributions</a> · <a href="${url}/reports">Your sample reports</a> · <a href="${url}/reconcile">Check an original form key</a> · <a href="${url}/choice">Sharing choice</a></nav><section class="reading">${warning}<h1>${escape(title)}</h1>${body}</section>`,
  );
}
function confirmation(text: string) {
  return `<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${escape(text)}</span></label>`;
}
function originalKey(
  circle: string,
  kind: "post" | "report" | "choice" | "moderation",
) {
  const key = randomUUID();
  const url =
    kind === "moderation"
      ? `/moderate/circles/${encodeURIComponent(circle)}/reconcile`
      : `${base(circle)}/reconcile`;
  return `<input type="hidden" name="idempotencyKey" value="${key}"><details><summary>Submission recovery</summary><p>Keep <a href="${escape(`${url}?kind=${kind}&key=${key}`)}">this original-key recovery link</a> if the result is unconfirmed. It checks only your retained receipt and does not submit anything.</p></details>`;
}
function composer(circle: string, csrf: string, root?: string) {
  return `<form method="post" action="${base(circle)}/posts">${hidden(csrf)}${originalKey(circle, "post")}${root ? `<input type="hidden" name="rootId" value="${escape(root)}">` : ""}<label for="circle-body">${root ? "Your invented reply" : "Your invented question"} (up to 2,000 characters)</label><textarea id="circle-body" name="body" maxlength="2000" required></textarea>${confirmation("I used only invented information and choose to share it with this circle.")}<button type="submit">${root ? "Share reply" : "Share question"}</button></form>`;
}
function item(circle: string, csrf: string, row: CircleItem, owned: boolean) {
  const url = base(circle);
  return `<li><article><h2>${escape(row.pseudonym)}</h2><p class="small">${escape(row.createdAt)} · ${escape(row.state)} · revision ${row.revision}</p>${row.body === null ? "<p>Text withdrawn.</p>" : `<pre class="content-text">${escape(row.body)}</pre>`}${owned ? (row.state === "withdrawn" ? "" : `<form method="post" action="${url}/posts/${encodeURIComponent(row.id)}/withdraw">${hidden(csrf)}${confirmation("Withdraw this contribution's text; a content-free marker remains until account deletion.")}<button type="submit">Withdraw contribution</button></form>`) : `<p><a href="${url}/threads/${encodeURIComponent(row.rootId ?? row.id)}">Open question and replies</a></p><form method="post" action="${url}/posts/${encodeURIComponent(row.id)}/reports">${hidden(csrf)}${originalKey(circle, "report")}<label for="report-${escape(row.id)}">Report this exact invented contribution</label><select id="report-${escape(row.id)}" name="category">${REPORT_CATEGORIES.map((category) => `<option value="${category}">${escape(category.replace("_", " "))}</option>`).join("")}</select><button type="submit">Save private sample report</button></form>`}</article></li>`;
}
function listing(
  circle: string,
  csrf: string,
  rows: CirclePage,
  url: string,
  owned = false,
) {
  return `${rows.items.length ? `<ul>${rows.items.map((row) => item(circle, csrf, row, owned)).join("")}</ul>` : "<p>No contributions available on this page.</p>"}${rows.nextCursor ? `<p><a href="${url}?cursor=${encodeURIComponent(rows.nextCursor)}">Next page</a></p>` : ""}`;
}
function fields(req: Request, allowed: string[]) {
  const body = req.body as Record<string, unknown>;
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).every((key) => ["csrf", ...allowed].includes(key)) &&
    Object.values(body).every((value) => typeof value === "string")
  );
}
function result<T>(
  res: Response,
  circle: string,
  value: CircleResult<T>,
): T | undefined {
  if (value.kind === "ready") return value.value;
  res
    .status(
      value.kind === "denied" ? 403 : value.kind === "invalid" ? 422 : 409,
    )
    .send(
      shell(
        circle,
        "Circle request unavailable",
        `<p>The request was not accepted (${escape(value.kind)}). Inspect the current sharing choice and your retained contributions before submitting another form.</p>`,
      ),
    );
}
export function registerCircleDiscussion(
  app: Express,
  store: CircleDiscussionStore,
) {
  const route =
    (
      operation: (
        req: Request,
        res: Response,
        circle: string,
        token: string,
        csrf: string,
      ) => Promise<void>,
    ) =>
    async (req: Request, res: Response) => {
      const circle = req.params.id as string;
      try {
        await operation(
          req,
          res,
          circle,
          res.locals.token as string,
          res.locals.csrf as string,
        );
      } catch {
        const key = req.body?.idempotencyKey;
        const path = req.route?.path;
        const kind =
          path === "/circles/:id/discussion/posts"
            ? "post"
            : path === "/circles/:id/discussion/choice"
              ? "choice"
              : path === "/circles/:id/discussion/posts/:postId/reports"
                ? "report"
                : path === "/moderate/circles/:id/posts/:postId"
                  ? "moderation"
                  : null;
        const receiptUrl =
          kind === "moderation"
            ? `/moderate/circles/${encodeURIComponent(circle)}/reconcile`
            : `${base(circle)}/reconcile`;
        const recovery =
          req.method === "POST" &&
          kind &&
          typeof key === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            key,
          )
            ? `<p><a href="${escape(`${receiptUrl}?kind=${kind}&key=${encodeURIComponent(key)}`)}">Check the original form key</a></p>`
            : "";
        res
          .status(503)
          .send(
            shell(
              circle,
              "Circle result unconfirmed",
              `<p>The operation could not be confirmed. Inspect your current contributions and sharing choice. Keep the original form key if reconciling a submission; do not create a new submission merely because a response was lost.</p>${recovery}`,
            ),
          );
      }
    };
  const cursor = (req: Request) =>
    Object.keys(req.query).every((key) => key === "cursor") &&
    (req.query.cursor === undefined || typeof req.query.cursor === "string");
  const rejectFields = (res: Response, circle: string) =>
    result(res, circle, { kind: "invalid" });
  function reconciliationForm(circle: string, moderator: boolean) {
    const url = moderator
      ? `/moderate/circles/${encodeURIComponent(circle)}/reconcile`
      : `${base(circle)}/reconcile`;
    return `<form method="get" action="${url}">${moderator ? '<input type="hidden" name="kind" value="moderation">' : '<label for="receipt-kind">Original submission type</label><select id="receipt-kind" name="kind"><option value="post">Contribution</option><option value="report">Sample report</option><option value="choice">Sharing choice</option></select>'}<label for="receipt-key">Original form key</label><input id="receipt-key" name="key" maxlength="36" required><button type="submit">Check original form key</button></form>`;
  }
  for (const moderator of [false, true])
    app.get(
      moderator
        ? "/moderate/circles/:id/reconcile"
        : "/circles/:id/discussion/reconcile",
      route(async (req, res, circle, token) => {
        const url = moderator
          ? `/moderate/circles/${encodeURIComponent(circle)}/reports`
          : `${base(circle)}/owned`;
        let content = reconciliationForm(circle, moderator);
        if (!Object.keys(req.query).length) {
          // Even the blank recovery form requires current ownership or staff grant.
          if (
            !result(
              res,
              circle,
              await store.reconcile(
                token,
                circle,
                moderator ? "moderation" : "post",
                randomUUID(),
              ),
            )
          )
            return;
        } else {
          if (
            Object.keys(req.query).some(
              (key) => !["kind", "key"].includes(key),
            ) ||
            typeof req.query.kind !== "string" ||
            typeof req.query.key !== "string" ||
            (moderator
              ? req.query.kind !== "moderation"
              : !["post", "report", "choice"].includes(req.query.kind))
          ) {
            rejectFields(res, circle);
            return;
          }
          const receipt = result(
            res,
            circle,
            await store.reconcile(token, circle, req.query.kind, req.query.key),
          );
          if (!receipt) return;
          content = receipt.found
            ? `<p role="status">Original-key receipt: ${escape(receipt.status!)}${receipt.revision === null ? "" : ` · revision ${receipt.revision}`}${receipt.id === null ? "" : ` · receipt ${escape(receipt.id)}`}.</p><p>This is a retained record, not permission to publish or a promise of moderation. Do not submit the same contribution with a new key.</p>`
            : `<p role="status">No retained receipt was found for this actor, circle, submission type and original key. This does not confirm whether an earlier request committed: records may have been erased or access may have changed. Inspect your retained records and preserve the original form before deciding how to proceed.</p>`;
        }
        res.send(
          page(
            "Check original circle submission",
            `<section class="reading">${warning}<h1>Check original circle submission</h1>${content}<p><a href="${url}">${moderator ? "Inspect current report worklist" : "Inspect your retained contributions"}</a></p></section>`,
          ),
        );
      }),
    );
  app.get(
    "/circles/:id/discussion/choice",
    route(async (_req, res, circle, token, csrf) => {
      const value = result(res, circle, await store.choice(token, circle));
      if (!value) return;
      res.send(
        shell(
          circle,
          "Choose circle sharing",
          `<p>Joining a circle does not give permission to share discussion text. This choice applies only to this circle, current membership generation ${escape(value.generation)}, and policy <strong>${CIRCLE_DISCUSSION_POLICY}</strong>. Leaving or withdrawing the choice removes your contributions from peer views. A later choice does not republish older contributions.</p>${value.active ? `<p role="status">Your current sharing choice is active.</p><form method="post" action="${base(circle)}/choice/withdraw">${hidden(csrf)}${confirmation("Withdraw this circle's sharing permission.")}<button type="submit">Withdraw sharing permission</button></form>` : `<form method="post" action="${base(circle)}/choice">${hidden(csrf)}<input type="hidden" name="generation" value="${escape(value.generation)}"><input type="hidden" name="policyVersion" value="${CIRCLE_DISCUSSION_POLICY}">${originalKey(circle, "choice")}${confirmation("I choose invented local discussion sharing under this exact circle policy.")}<button type="submit">Enable invented circle sharing</button></form>`}`,
        ),
      );
    }),
  );
  app.post(
    "/circles/:id/discussion/choice",
    route(async (req, res, circle, token) => {
      if (
        !fields(req, [
          "generation",
          "policyVersion",
          "idempotencyKey",
          "confirm",
        ])
      ) {
        rejectFields(res, circle);
        return;
      }
      if (
        result(
          res,
          circle,
          await store.choose(
            token,
            circle,
            req.body.idempotencyKey,
            req.body.generation,
            req.body.policyVersion,
            req.body.confirm === "yes",
          ),
        )
      )
        res.redirect(303, base(circle));
    }),
  );
  app.post(
    "/circles/:id/discussion/choice/withdraw",
    route(async (req, res, circle, token) => {
      if (!fields(req, ["confirm"])) {
        rejectFields(res, circle);
        return;
      }
      if (
        result(
          res,
          circle,
          await store.withdrawChoice(token, circle, req.body.confirm === "yes"),
        )
      )
        res.redirect(303, `${base(circle)}/owned`);
    }),
  );
  app.get(
    "/circles/:id/discussion",
    route(async (req, res, circle, token, csrf) => {
      if (!cursor(req)) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.list(token, circle, req.query.cursor as string | undefined),
      );
      if (value)
        res.send(
          shell(
            circle,
            "Invented circle questions",
            `${listing(circle, csrf, value, base(circle))}<h2>Ask a question</h2>${composer(circle, csrf)}`,
          ),
        );
    }),
  );
  app.get(
    "/circles/:id/discussion/owned",
    route(async (req, res, circle, token, csrf) => {
      if (!cursor(req)) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.owned(
          token,
          circle,
          req.query.cursor as string | undefined,
        ),
      );
      if (value)
        res.send(
          shell(
            circle,
            "Your retained circle contributions",
            `<p>These are your private retained records, including hidden contributions. Earlier circle choices never republish them. Withdraw a contribution to remove its saved body; delete your account to erase your owned records.</p>${listing(circle, csrf, value, `${base(circle)}/owned`, true)}<p><a href="/member/export">Download your private records</a></p>`,
          ),
        );
    }),
  );
  app.get(
    "/circles/:id/discussion/threads/:postId",
    route(async (req, res, circle, token, csrf) => {
      if (!cursor(req)) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.thread(
          token,
          circle,
          req.params.postId as string,
          req.query.cursor as string | undefined,
        ),
      );
      if (value)
        res.send(
          shell(
            circle,
            "Invented question and replies",
            `<ul>${item(circle, csrf, value.root, false)}</ul><h2>Replies</h2>${listing(circle, csrf, value.replies, `${base(circle)}/threads/${encodeURIComponent(value.root.id)}`)}<h2>Add a reply</h2>${composer(circle, csrf, value.root.id)}`,
          ),
        );
    }),
  );
  app.post(
    "/circles/:id/discussion/posts",
    route(async (req, res, circle, token) => {
      if (
        !fields(req, ["idempotencyKey", "body", "rootId", "confirm"]) ||
        typeof req.body.body !== "string"
      ) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.post(
          token,
          circle,
          req.body.idempotencyKey,
          req.body.body,
          req.body.confirm === "yes",
          req.body.rootId,
        ),
      );
      if (value) res.redirect(303, `${base(circle)}/owned`);
    }),
  );
  app.post(
    "/circles/:id/discussion/posts/:postId/withdraw",
    route(async (req, res, circle, token) => {
      if (!fields(req, ["confirm"])) {
        rejectFields(res, circle);
        return;
      }
      if (
        result(
          res,
          circle,
          await store.withdraw(
            token,
            circle,
            req.params.postId as string,
            req.body.confirm === "yes",
          ),
        )
      )
        res.redirect(303, `${base(circle)}/owned`);
    }),
  );
  app.post(
    "/circles/:id/discussion/posts/:postId/reports",
    route(async (req, res, circle, token) => {
      if (!fields(req, ["idempotencyKey", "category"])) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.report(
          token,
          circle,
          req.params.postId as string,
          req.body.idempotencyKey,
          req.body.category,
        ),
      );
      if (value)
        res.send(
          shell(
            circle,
            "Private sample report receipt",
            `<p role="status">Sample report saved. Receipt ${escape(value.id)}. This content-free receipt does not promise a response or formal moderation.</p><p><a href="${base(circle)}/reports/${encodeURIComponent(value.id)}">Open your durable sample receipt</a></p>`,
          ),
        );
    }),
  );
  app.get(
    "/moderate/circles/:id/reports",
    route(async (req, res, circle, token, csrf) => {
      if (!cursor(req)) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.moderationQueue(
          token,
          circle,
          req.query.cursor as string | undefined,
        ),
      );
      if (!value) return;
      const url = `/moderate/circles/${encodeURIComponent(circle)}`;
      const rows = value.items
        .map(
          (report) =>
            `<li><article><h2>Sample report ${escape(report.category.replace("_", " "))}</h2>${report.target ? `<p>${escape(report.target.pseudonym)} · ${escape(report.target.state)} · revision ${report.target.revision}</p><pre class="content-text">${escape(report.target.body!)}</pre><form method="post" action="${url}/posts/${encodeURIComponent(report.target.id)}">${hidden(csrf)}${originalKey(circle, "moderation")}<input type="hidden" name="expectedRevision" value="${report.target.revision}"><input type="hidden" name="action" value="${report.target.state === "hidden" ? "restore" : "hide"}"><label for="reason-${escape(report.id)}">Synthetic decision reason</label><select id="reason-${escape(report.id)}" name="reason"><option value="privacy">Privacy</option><option value="conduct">Conduct</option><option value="off_topic">Off topic</option><option value="test_correction">Test correction</option></select><button type="submit">${report.target.state === "hidden" ? "Restore invented contribution" : "Hide invented contribution"}</button></form>` : "<p>Target unavailable. No text or restoration action is available.</p>"}</article></li>`,
        )
        .join("");
      res.send(
        page(
          "Synthetic circle report worklist",
          `<section class="reading">${warning}<h1>Synthetic circle report worklist</h1><p><a href="${url}/reconcile">Check an original action key</a></p><p>Your current grant applies only to this exact circle and test purpose. Reporter identity is not displayed. Actions do not establish staffed moderation, appeal coverage or qualified approval.</p>${rows ? `<ul>${rows}</ul>` : "<p>No reports available on this page.</p>"}${value.nextCursor ? `<p><a href="${url}/reports?cursor=${encodeURIComponent(value.nextCursor)}">Next page</a></p>` : ""}</section>`,
        ),
      );
    }),
  );
  app.post(
    "/moderate/circles/:id/posts/:postId",
    route(async (req, res, circle, token) => {
      if (
        !fields(req, [
          "idempotencyKey",
          "expectedRevision",
          "action",
          "reason",
        ]) ||
        typeof req.body.expectedRevision !== "string" ||
        !/^[1-9][0-9]{0,9}$/.test(req.body.expectedRevision)
      ) {
        rejectFields(res, circle);
        return;
      }
      if (
        result(
          res,
          circle,
          await store.moderate(
            token,
            circle,
            req.params.postId as string,
            req.body.idempotencyKey,
            req.body.action,
            Number(req.body.expectedRevision),
            req.body.reason,
          ),
        )
      )
        res.redirect(
          303,
          `/moderate/circles/${encodeURIComponent(circle)}/reports`,
        );
    }),
  );
  app.get(
    "/circles/:id/discussion/reports",
    route(async (req, res, circle, token) => {
      if (!cursor(req)) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.reports(
          token,
          circle,
          req.query.cursor as string | undefined,
        ),
      );
      if (!value) return;
      const url = `${base(circle)}/reports`;
      res.send(
        shell(
          circle,
          "Your private sample reports",
          `<p>These are only your own content-free sample receipts. A retained receipt promises no staffed response, appeal or formal review. Leaving a circle does not remove your private receipts.</p>${value.items.length ? `<ul>${value.items.map((report) => `<li><a href="${url}/${encodeURIComponent(report.id)}">Receipt ${escape(report.id)}</a> · ${escape(report.category)} · ${report.status === "unavailable" ? "Target unavailable" : report.status === "hidden" ? "Sample target hidden" : "Sample report retained"}</li>`).join("")}</ul>` : "<p>No own sample reports on this page.</p>"}${value.nextCursor ? `<p><a href="${url}?cursor=${encodeURIComponent(value.nextCursor)}">Next page</a></p>` : ""}`,
        ),
      );
    }),
  );
  app.get(
    "/circles/:id/discussion/reports/:reportId",
    route(async (req, res, circle, token) => {
      if (Object.keys(req.query).length) {
        rejectFields(res, circle);
        return;
      }
      const value = result(
        res,
        circle,
        await store.reportReceipt(token, circle, req.params.reportId as string),
      );
      if (value)
        res.send(
          shell(
            circle,
            "Your private sample report receipt",
            `<p>Receipt ${escape(value.id)} · ${escape(value.category)} · ${escape(value.createdAt)}</p><p role="status">${value.status === "unavailable" ? "Target unavailable" : value.status === "hidden" ? "Sample target hidden" : "Sample report retained"}. This content-free record does not promise staffed moderation, a response or formal review.</p><p><a href="${base(circle)}/reports">Your private sample reports</a></p>`,
          ),
        );
    }),
  );
}
