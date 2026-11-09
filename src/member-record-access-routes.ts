import type { Express, Request, Response } from "express";
import type { MemberRecordAccess } from "./member-record-access.ts";
import {
  OPERATOR_RECORDS_PATH,
  RECORD_ACCESS_PATH,
  operatorRecordsPage,
  operatorRecordsRefusal,
  recordAccessPage,
  recordAccessRefusal,
} from "./member-record-access-views.ts";

/** Only the named form fields, as strings, and no query. */
function fields(req: Request, allowed: string[]) {
  const body: unknown = req.body;
  return (
    !Object.keys(req.query).length &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.entries(body).every(
      ([key, value]) =>
        (key === "csrf" || allowed.includes(key)) && typeof value === "string",
    )
  );
}
function send(res: Response, [status, html]: [number, string]) {
  return res.status(status).send(html);
}

/** #40 RECACCESS: member-authorized, scoped, logged operator downloads. */
export function mountMemberRecordAccess(
  app: Express,
  store: MemberRecordAccess | undefined,
) {
  if (!store) return;
  const token = (res: Response) => res.locals.token as string;
  app.get(RECORD_ACCESS_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).length)
      return send(res, recordAccessRefusal("invalid"));
    const result = await store.list(token(res));
    if (result.kind === "denied") return res.redirect(303, "/");
    if (result.kind !== "ready")
      return send(res, recordAccessRefusal("unavailable"));
    return res.send(
      recordAccessPage(
        result.value,
        res.locals.csrf as string,
        (res.locals.learner as { id: string }).id,
      ),
    );
  });
  const change = async (
    res: Response,
    work: Promise<{ kind: "ready" | "denied" | "invalid" | "unavailable" }>,
  ) => {
    const result = await work;
    if (result.kind === "ready") return res.redirect(303, RECORD_ACCESS_PATH);
    if (result.kind === "denied") return res.redirect(303, "/");
    return send(res, recordAccessRefusal(result.kind));
  };
  app.post(RECORD_ACCESS_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fields(req, ["scope"]))
      return send(res, recordAccessRefusal("invalid"));
    return change(res, store.grant(token(res), req.body.scope));
  });
  app.post(`${RECORD_ACCESS_PATH}/:id/revoke`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fields(req, [])) return send(res, recordAccessRefusal("invalid"));
    return change(res, store.revoke(token(res), req.params.id));
  });

  app.get(OPERATOR_RECORDS_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).length)
      return send(res, operatorRecordsRefusal("invalid"));
    const allowed = await store.operator(token(res));
    if (allowed !== "allowed") return send(res, operatorRecordsRefusal(allowed));
    return res.send(operatorRecordsPage(res.locals.csrf as string));
  });
  app.post(OPERATOR_RECORDS_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fields(req, ["reference", "scope", "cursor"]))
      return send(res, operatorRecordsRefusal("invalid"));
    const cursor = (req.body.cursor as string | undefined)?.trim();
    const result = await store.download(
      token(res),
      (req.body.reference as string | undefined)?.trim().toLowerCase(),
      req.body.scope,
      cursor ? cursor : undefined,
    );
    if (result.kind !== "ready") return send(res, operatorRecordsRefusal(result.kind));
    const { payload } = result;
    res.set(
      "Content-Disposition",
      `attachment; filename="member-${payload.reference}-${payload.scope}-page-${payload.page.number}.json"`,
    );
    return res.type("application/json").send(JSON.stringify(payload));
  });
}
