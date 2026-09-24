import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { COOKIE, COOKIE_OPTIONS, token, csrf, validCsrf } from "./session.ts";
import { profile, submission, type Fields } from "./validation.ts";
import {
  welcome,
  dashboard,
  lesson,
  readinessPage,
  offerHypothesesPage,
  libraryPage,
  workflowRegistryPage,
  workflowDetailPage,
  circlesPage,
  contentPreview,
  staffLibraryPage,
  trackReadinessPage,
  expertRegistryPage,
  proposalListPage,
  proposalPreviewPage,
  moderationPage,
  milestonesPage,
  careerPage,
  errorPage,
} from "./views.ts";
import type { Store, Learner } from "./store.ts";
import { eligibleAssignments } from "./assignment-choice.ts";
import { parseMilestone, validMilestoneId } from "./milestones.ts";
import {
  disabledCareerStore,
  parseCareerEntry,
  parseCareerDraft,
  validCareerId,
  type CareerStore,
} from "./career.ts";
import {
  adapterReadiness,
  type AdapterReadiness,
  type ApplicationMode,
} from "./adapters.ts";
import {
  disabledAuthorizationStore,
  type AuthorizationStore,
} from "./authorization.ts";
import {
  disabledEvidenceStore,
  MAX_EVIDENCE_BYTES,
  type EvidenceStore,
} from "./evidence.ts";
import { FOUNDATION_ACCESS, COACHING_OFFERS } from "./offers.ts";
import {
  disabledCatalogStore,
  type CatalogStore,
  type DraftContent,
} from "./catalog.ts";
import { disabledTrackStore, type TrackStore } from "./track-readiness.ts";
import { disabledProposalStore, type ProposalStore } from "./proposals.ts";
import { workflowBundle, workflowRegistry } from "./workflow-registry.ts";
import { disabledCircleStore, type CircleStore } from "./circles.ts";
import { disabledMetricsStore, type MetricsStore } from "./metrics.ts";
export function app(
  store: Store,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    adapters?: AdapterReadiness[];
    authorization?: AuthorizationStore;
    evidence?: EvidenceStore;
    catalog?: CatalogStore;
    tracks?: TrackStore;
    proposals?: ProposalStore;
    career?: CareerStore;
    circles?: CircleStore;
    metrics?: MetricsStore;
  },
) {
  const app = express();
  const mode = options.mode ?? "demo";
  const adapters = options.adapters ?? adapterReadiness({}, mode);
  const authorization = options.authorization ?? disabledAuthorizationStore();
  const evidence = options.evidence ?? disabledEvidenceStore();
  const catalog = options.catalog ?? disabledCatalogStore();
  const tracks = options.tracks ?? disabledTrackStore();
  const proposals = options.proposals ?? disabledProposalStore();
  const career = options.career ?? disabledCareerStore();
  const circles = options.circles ?? disabledCircleStore();
  const metrics = options.metrics ?? disabledMetricsStore();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": null },
      },
      strictTransportSecurity: false,
      referrerPolicy: { policy: "same-origin" },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use((req, res, next) => {
    if (req.get("host") !== new URL(options.origin).host) {
      res
        .status(403)
        .send(
          errorPage(
            "Unrecognized address",
            "Open this preview using its configured loopback address.",
          ),
        );
      return;
    }
    next();
  });
  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public", import.meta.url))),
  );
  app.use(
    "/api/evidence",
    express.raw({ type: "*/*", limit: MAX_EVIDENCE_BYTES }),
  );
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const session = token(req.cookies[COOKIE]);
    res.locals.token = session;
    res.locals.csrf = csrf(session, options.secret);
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      (req.get("origin") !== options.origin ||
        !validCsrf(
          req.get("x-csrf-token") ?? (req.body as Fields | undefined)?.csrf,
          session,
          options.secret,
        ))
    ) {
      res
        .status(403)
        .send(
          errorPage(
            "Your form needs a refresh",
            "Open your learning path again, then retry. Your saved work is unchanged.",
          ),
        );
      return;
    }
    next();
  });
  app.get("/readiness", (_req, res) => res.send(readinessPage(mode, adapters)));
  app.get("/readiness/offers", (_req, res) => res.send(offerHypothesesPage()));
  app.get("/readiness/tracks", async (_req, res) =>
    res.send(trackReadinessPage(await tracks.snapshot())),
  );
  app.get("/operator/experts", async (_req, res) => {
    const records = await tracks.registry(res.locals.token as string);
    if (!records) {
      res
        .status(403)
        .send(
          errorPage("Registry unavailable", "Operator access is required."),
        );
      return;
    }
    res.send(expertRegistryPage(records));
  });
  app.get("/operator/metrics", async (_req, res) => {
    const snapshot = await metrics.snapshot(res.locals.token as string);
    if (!snapshot) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(snapshot);
  });
  app.get("/moderate/proposals", async (_req, res) => {
    const queue = await proposals.moderationQueue(res.locals.token as string);
    if (!queue) {
      res
        .status(403)
        .send(
          errorPage("Moderation unavailable", "Moderator access is required."),
        );
      return;
    }
    res.send(moderationPage(queue, res.locals.csrf as string));
  });
  app.post("/moderate/proposals/:id/:action", async (req, res) => {
    const action = req.params.action;
    if (
      (action !== "quarantine" && action !== "reject") ||
      !(await proposals.moderate(
        res.locals.token as string,
        req.params.id as string,
        action,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Proposal unchanged",
            "Check moderation access and current state.",
          ),
        );
      return;
    }
    res.redirect(303, "/moderate/proposals");
  });
  app.get("/api/offer-hypotheses", (_req, res) =>
    res.json({
      foundation: FOUNDATION_ACCESS,
      coaching: COACHING_OFFERS,
    }),
  );
  app.get("/api/workspaces/:workspaceId/private", async (req, res) => {
    const purpose =
      typeof req.query.purpose === "string" ? req.query.purpose : undefined;
    const access = await authorization.readWorkspace(
      res.locals.token as string,
      req.params.workspaceId as string,
      purpose,
    );
    if (access.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(access);
  });
  app.get("/api/cohorts/:cohortId/content/:contentId", async (req, res) => {
    const access = await authorization.readCohort(
      res.locals.token as string,
      req.params.cohortId as string,
      req.params.contentId as string,
    );
    if (access.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json(access);
  });
  app.post("/api/evidence", async (req, res) => {
    const scopes = (req.get("x-evidence-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const learningCircle = scopes.includes("learning-circle")
      ? (req.get("x-learning-circle-id") ?? "")
      : undefined;
    const result = await evidence.upload(res.locals.token as string, {
      name: req.get("x-evidence-name") ?? "",
      mediaType: (req.get("content-type") ?? "").split(";", 1)[0]!,
      consent: {
        rightsConfirmed: req.get("x-evidence-rights") === "confirmed",
        privateReview: scopes.includes("private-review"),
        communityPublication: scopes.includes("community-publication"),
        learningCircleId: learningCircle,
      },
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    if (result.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (result.kind === "invalid") {
      res.status(422).json({ error: "invalid_evidence" });
      return;
    }
    res.status(201).json(result);
  });
  app.post("/api/evidence/:evidenceId/review", async (req, res) => {
    if (
      !(await evidence.submitForReview(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res.status(409).json({ error: "evidence_not_ready" });
      return;
    }
    res.status(204).end();
  });
  app.post("/api/evidence/:evidenceId/download-link", async (req, res) => {
    const result = await evidence.issueDownload(
      res.locals.token as string,
      req.params.evidenceId as string,
    );
    if (result.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json({
      href: `/api/evidence/${req.params.evidenceId as string}/download?capability=${result.capability}`,
      expiresAt: result.expiresAt.toISOString(),
    });
  });
  app.get("/api/evidence/:evidenceId/download", async (req, res) => {
    const result = await evidence.download(
      res.locals.token as string,
      req.params.evidenceId as string,
      typeof req.query.capability === "string" ? req.query.capability : "",
    );
    if (result.kind === "denied") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res
      .type(result.mediaType)
      .set("Content-Disposition", `attachment; filename="${result.name}"`)
      .send(result.data);
  });
  app.delete("/api/evidence/:evidenceId", async (req, res) => {
    if (
      !(await evidence.remove(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.status(204).end();
  });
  app.get("/", async (req, res) => {
    const session = await store.session(res.locals.token as string);
    if (session.kind === "active") {
      res.redirect(303, "/learn");
      return;
    }
    const fresh =
      session.kind === "expired"
        ? token(undefined)
        : (res.locals.token as string);
    res.cookie(COOKIE, fresh, COOKIE_OPTIONS);
    res.send(welcome(csrf(fresh, options.secret)));
  });
  app.post("/start", async (req, res) => {
    const input = profile(req.body as Fields);
    if (!input) {
      res
        .status(422)
        .send(
          welcome(res.locals.csrf as string, [
            "Choose valid starting point, goal, time zone, weekly time and optional interests, and confirm you will use sample information.",
          ]),
        );
      return;
    }
    await store.create(res.locals.token as string, input);
    res.redirect(303, "/learn");
  });
  app.use(
    [
      "/learn",
      "/lesson",
      "/exercise",
      "/profile",
      "/delete",
      "/library",
      "/assignments",
      "/milestones",
      "/career",
      "/contribute",
      "/circles",
    ],
    async (_req, res, next) => {
      const session = await store.session(res.locals.token as string);
      if (session.kind !== "active") {
        res.redirect(303, "/");
        return;
      }
      res.locals.learner = session.learner;
      next();
    },
  );
  app.get("/circles", async (_req, res) => {
    const items = await circles.list(res.locals.token as string);
    if (!items) {
      res
        .status(403)
        .send(errorPage("Circles unavailable", "Refresh your session."));
      return;
    }
    res.send(
      circlesPage(
        items,
        (res.locals.learner as Learner).goal,
        res.locals.csrf as string,
      ),
    );
  });
  app.post("/circles/:id/join", async (req, res) => {
    const result = await circles.join(
      res.locals.token as string,
      req.params.id as string,
    );
    if (result !== "joined") {
      res
        .status(result === "full" ? 409 : 404)
        .send(
          errorPage(
            result === "full" ? "Circle is full" : "Circle unavailable",
            "Your membership was not changed. Return to the circle list for current availability.",
          ),
        );
      return;
    }
    res.redirect(303, "/circles");
  });
  app.post("/circles/:id/leave", async (req, res) => {
    if (
      !(await circles.leave(
        res.locals.token as string,
        req.params.id as string,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Membership unchanged",
            "You may already have left this circle. Refresh the list to check.",
          ),
        );
      return;
    }
    res.redirect(303, "/circles");
  });
  app.get("/contribute", async (_req, res) =>
    res.send(
      proposalListPage(
        await proposals.owned(res.locals.token as string),
        res.locals.csrf as string,
      ),
    ),
  );
  app.post("/contribute", async (req, res) => {
    const fields = req.body as Fields;
    const value = (name: string) =>
      typeof fields[name] === "string" ? (fields[name] as string) : "";
    const id = await proposals.createDraft(
      res.locals.token as string,
      { title: value("title"), body: value("body"), sources: value("sources") },
      fields.sample_confirmed === "yes",
    );
    if (!id) {
      res
        .status(422)
        .send(
          errorPage(
            "Proposal not saved",
            "Use sample information and complete every field.",
          ),
        );
      return;
    }
    res.redirect(303, `/contribute/${id}`);
  });
  app.get("/contribute/:id", async (req, res) => {
    const proposal = await proposals.preview(
      res.locals.token as string,
      req.params.id as string,
    );
    if (!proposal) {
      res
        .status(404)
        .send(
          errorPage(
            "Proposal unavailable",
            "Only your own proposal can be opened.",
          ),
        );
      return;
    }
    res.send(proposalPreviewPage(proposal, res.locals.csrf as string));
  });
  app.post("/contribute/:id/submit", async (req, res) => {
    if (
      !(await proposals.submit(
        res.locals.token as string,
        req.params.id as string,
        req.body.rights_confirmed === "yes",
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Proposal not submitted",
            "Confirm original rights and check draft state.",
          ),
        );
      return;
    }
    res.redirect(303, `/contribute/${req.params.id}`);
  });
  app.post("/contribute/:id/withdraw", async (req, res) => {
    if (
      req.body.confirm !== "yes" ||
      !(await proposals.withdraw(
        res.locals.token as string,
        req.params.id as string,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Proposal not withdrawn",
            "Confirm withdrawal and check the current state.",
          ),
        );
      return;
    }
    res.redirect(303, `/contribute/${req.params.id}`);
  });
  app.get("/workflows", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.send(workflowRegistryPage(await workflowRegistry(q), q.slice(0, 100)));
  });
  app.get("/workflows/:id", async (req, res) => {
    const item = await workflowBundle(req.params.id as string);
    if (!item) {
      res
        .status(404)
        .send(
          errorPage(
            "Workflow unavailable",
            "This demonstration does not exist.",
          ),
        );
      return;
    }
    res.send(workflowDetailPage(item));
  });
  app.get("/workflows/:id/download", async (req, res) => {
    const item = await workflowBundle(req.params.id as string);
    if (!item) {
      res
        .status(404)
        .send(
          errorPage(
            "Workflow unavailable",
            "This demonstration does not exist.",
          ),
        );
      return;
    }
    res.type("text/markdown; charset=utf-8");
    res.attachment(`${item.id}-v${item.version}.md`);
    res.send(item.download);
  });
  app.get("/library", async (req, res) => {
    const member = res.locals.learner as Learner;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const goal =
      typeof req.query.goal === "string" ? req.query.goal : undefined;
    const background =
      typeof req.query.background === "string"
        ? req.query.background
        : undefined;
    const domain =
      typeof req.query.domain === "string" ? req.query.domain : undefined;
    res.send(
      libraryPage(
        await catalog.search({ q, goal, background, domain }),
        { q, goal, background, domain },
        await store.lessonActivities(member.id),
      ),
    );
  });
  app.get("/library/:id", async (req, res) => {
    const member = res.locals.learner as Learner;
    const item = await catalog.published(req.params.id as string);
    if (!item) {
      res
        .status(404)
        .send(
          errorPage(
            "Content unavailable",
            "Only published versions appear in the learning library.",
          ),
        );
      return;
    }
    if (item.kind === "lesson") {
      if (!(await store.openLesson(member.id, item.id, item.version))) {
        res
          .status(409)
          .send(
            errorPage(
              "Lesson changed",
              "Return to the library for the current published version.",
            ),
          );
        return;
      }
    }
    const activity =
      item.kind === "lesson"
        ? (await store.lessonActivities(member.id)).find(
            (entry) =>
              entry.contentId === item.id &&
              entry.contentVersion === item.version,
          )
        : undefined;
    res.send(contentPreview(item, false, res.locals.csrf as string, activity));
  });
  app.post("/library/:id/progress", async (req, res) => {
    const fields = req.body as Fields;
    const version = Number(fields.content_version);
    const action = fields.intent;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      (action !== "start" && action !== "complete") ||
      (action === "complete" && fields.confirm !== "yes")
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Invalid lesson action",
            "Return to the current lesson and choose an available action.",
          ),
        );
      return;
    }
    const member = res.locals.learner as Learner;
    if (
      !(await store.advanceLesson(
        member.id,
        req.params.id as string,
        version,
        action,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Lesson action unavailable",
            "This lesson version changed, is unavailable, or has not been started. Return to the library and check your saved history.",
          ),
        );
      return;
    }
    res.redirect(
      303,
      `/library/${encodeURIComponent(req.params.id as string)}`,
    );
  });
  app.get("/editor/library", async (_req, res) => {
    res.send(
      staffLibraryPage(
        await catalog.staffList(res.locals.token as string),
        res.locals.csrf as string,
      ),
    );
  });
  app.get("/editor/library/:id/:version", async (req, res) => {
    const item = await catalog.preview(
      res.locals.token as string,
      req.params.id as string,
      Number(req.params.version),
    );
    if (!item) {
      res
        .status(403)
        .send(
          errorPage(
            "Staff preview unavailable",
            "A current editor or reviewer identity is required.",
          ),
        );
      return;
    }
    res.send(contentPreview(item, true, res.locals.csrf as string));
  });
  app.post("/editor/library", async (req, res) => {
    const fields = req.body as Fields;
    const value = (name: string) =>
      typeof fields[name] === "string" ? (fields[name] as string) : "";
    const draft: DraftContent = {
      id: value("id"),
      version: Number(value("version")),
      kind: value("kind") as DraftContent["kind"],
      origin: "curated",
      title: value("title"),
      body: value("body"),
      owner: value("owner"),
      sources: value("sources"),
      rights: value("rights"),
      goals: [],
      backgrounds: [],
      domains: [],
      prerequisites: value("prerequisites"),
      minimumExperience: (value("minimum_experience") ||
        "new") as DraftContent["minimumExperience"],
      rubric: null,
      rubricVersion: null,
    };
    if (!(await catalog.createDraft(res.locals.token as string, draft))) {
      res
        .status(422)
        .send(
          errorPage(
            "Draft not saved",
            "Check the fields, next version and editor access.",
          ),
        );
      return;
    }
    res.redirect(303, `/editor/library/${draft.id}/${draft.version}`);
  });
  app.post("/editor/library/:id/:version/:action", async (req, res) => {
    const credential = res.locals.token as string;
    const id = req.params.id as string;
    const version = Number(req.params.version);
    const action = req.params.action;
    const changed =
      action === "submit"
        ? await catalog.submit(credential, id, version)
        : action === "approve"
          ? await catalog.approve(
              credential,
              id,
              version,
              req.body.rights_confirmed === "yes",
            )
          : action === "publish"
            ? await catalog.publish(credential, id, version)
            : false;
    if (!changed) {
      res
        .status(409)
        .send(
          errorPage(
            "Content state unchanged",
            "Check your staff role and the current review state.",
          ),
        );
      return;
    }
    res.redirect(303, `/editor/library/${id}/${version}`);
  });
  app.post("/editor/library/:id/retire", async (req, res) => {
    if (
      !(await catalog.retire(
        res.locals.token as string,
        req.params.id as string,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Content state unchanged",
            "Only a published version can be retired by an editor.",
          ),
        );
      return;
    }
    res.redirect(303, "/editor/library");
  });
  app.get("/learn", async (_req, res) => {
    const member = res.locals.learner as Learner;
    const [progress, published, choice] = await Promise.all([
      store.progress(member.id),
      catalog.search({}),
      store.assignmentChoice(member.id),
    ]);
    res.send(
      dashboard(
        member,
        progress,
        res.locals.csrf as string,
        [],
        eligibleAssignments(published, member, progress),
        choice,
      ),
    );
  });
  app.post("/assignments/select", async (req, res) => {
    const member = res.locals.learner as Learner;
    const fields = req.body as Fields;
    const id = typeof fields.content_id === "string" ? fields.content_id : "";
    const version = Number(fields.content_version);
    const progress = await store.progress(member.id);
    const options = eligibleAssignments(
      await catalog.search({}),
      member,
      progress,
    );
    if (
      !Number.isSafeInteger(version) ||
      !options.some((item) => item.id === id && item.version === version) ||
      !(await store.chooseAssignment(member.id, id, version))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Assignment choice unavailable",
            "The published assignment or its prerequisites changed. Return to your learning path and choose an available sample.",
          ),
        );
      return;
    }
    res.redirect(303, "/learn");
  });
  app.get("/milestones", async (_req, res) => {
    const member = res.locals.learner as Learner;
    res.send(
      milestonesPage(
        member,
        await store.milestones(member.id),
        res.locals.csrf as string,
      ),
    );
  });
  app.post("/milestones", async (req, res) => {
    const member = res.locals.learner as Learner;
    const parsed = parseMilestone(req.body as Fields, member.timezone);
    if (parsed.errors.length) {
      res
        .status(422)
        .send(
          milestonesPage(
            member,
            await store.milestones(member.id),
            res.locals.csrf as string,
            parsed.errors,
            parsed.input,
          ),
        );
      return;
    }
    if (!(await store.createMilestone(member.id, parsed.input))) {
      res
        .status(409)
        .send(
          errorPage(
            "Milestone unchanged",
            "Refresh your learning space and try again.",
          ),
        );
      return;
    }
    res.redirect(303, "/milestones");
  });
  app.post("/milestones/:id/update", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = Number((req.body as Fields).version);
    if (
      !validMilestoneId(id) ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Milestone unchanged",
            "Open your current milestone list and try again.",
          ),
        );
      return;
    }
    const parsed = parseMilestone(req.body as Fields, member.timezone);
    if (parsed.errors.length) {
      res
        .status(422)
        .send(
          milestonesPage(
            member,
            await store.milestones(member.id),
            res.locals.csrf as string,
            parsed.errors,
            parsed.input,
            id,
          ),
        );
      return;
    }
    if (!(await store.updateMilestone(member.id, id, version, parsed.input))) {
      res
        .status(409)
        .send(
          errorPage(
            "Milestone unchanged",
            "It may have changed in another tab. Open your current milestone list and try again.",
          ),
        );
      return;
    }
    res.redirect(303, "/milestones");
  });
  app.post("/milestones/:id/delete", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const fields = req.body as Fields;
    const version = Number(fields.version);
    if (
      fields.confirm !== "yes" ||
      !validMilestoneId(id) ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !(await store.deleteMilestone(member.id, id, version))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Milestone unchanged",
            "Confirm deletion on your current milestone list and try again.",
          ),
        );
      return;
    }
    res.redirect(303, "/milestones");
  });
  const careerConflict = (res: express.Response) =>
    res
      .status(409)
      .send(
        errorPage(
          "Career planning unchanged",
          "Open your current private planning page and try again.",
        ),
      );
  const careerVersion = (id: string, fields: Fields) => {
    const version = Number(fields.version);
    return validCareerId(id) && Number.isSafeInteger(version) && version > 0
      ? version
      : null;
  };
  app.get("/career", async (_req, res) => {
    const member = res.locals.learner as Learner;
    res.send(
      careerPage(await career.snapshot(member.id), res.locals.csrf as string),
    );
  });
  app.post("/career/enable", async (req, res) => {
    const member = res.locals.learner as Learner;
    if (
      (req.body as Fields).confirm !== "yes" ||
      !(await career.enable(member.id))
    ) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/disable", async (req, res) => {
    const member = res.locals.learner as Learner;
    if (
      (req.body as Fields).confirm !== "yes" ||
      !(await career.disable(member.id))
    ) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/entries", async (req, res) => {
    const member = res.locals.learner as Learner;
    const parsed = parseCareerEntry(req.body as Fields);
    if (parsed.errors.length) {
      res
        .status(422)
        .send(
          careerPage(
            await career.snapshot(member.id),
            res.locals.csrf as string,
            parsed.errors,
            { entry: parsed.input },
          ),
        );
      return;
    }
    if (!(await career.createEntry(member.id, parsed.input))) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/entries/:id/update", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if (version === null) {
      careerConflict(res);
      return;
    }
    const parsed = parseCareerEntry(req.body as Fields);
    if (parsed.errors.length) {
      res
        .status(422)
        .send(
          careerPage(
            await career.snapshot(member.id),
            res.locals.csrf as string,
            parsed.errors,
            { entry: parsed.input, editEntryId: id },
          ),
        );
      return;
    }
    if (!(await career.updateEntry(member.id, id, version, parsed.input))) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/entries/:id/delete", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if (
      (req.body as Fields).confirm !== "yes" ||
      version === null ||
      !(await career.deleteEntry(member.id, id, version))
    ) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/drafts", async (req, res) => {
    const member = res.locals.learner as Learner;
    const parsed = parseCareerDraft(req.body as Fields);
    if (parsed.errors.length) {
      res
        .status(422)
        .send(
          careerPage(
            await career.snapshot(member.id),
            res.locals.csrf as string,
            parsed.errors,
            { professional: parsed.input },
          ),
        );
      return;
    }
    if (!(await career.createDraft(member.id, parsed.input))) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/update", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if (version === null) {
      careerConflict(res);
      return;
    }
    const parsed = parseCareerDraft(req.body as Fields);
    if (parsed.errors.length) {
      res
        .status(422)
        .send(
          careerPage(
            await career.snapshot(member.id),
            res.locals.csrf as string,
            parsed.errors,
            { professional: parsed.input, editDraftId: id },
          ),
        );
      return;
    }
    if (!(await career.updateDraft(member.id, id, version, parsed.input))) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/approve", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if (
      (req.body as Fields).confirm !== "yes" ||
      version === null ||
      !(await career.approveDraft(member.id, id, version))
    ) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/revoke", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if (
      (req.body as Fields).confirm !== "yes" ||
      version === null ||
      !(await career.revokeDraft(member.id, id, version))
    ) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/delete", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if (
      (req.body as Fields).confirm !== "yes" ||
      version === null ||
      !(await career.deleteDraft(member.id, id, version))
    ) {
      careerConflict(res);
      return;
    }
    res.redirect(303, "/career");
  });
  app.post("/profile", async (req, res) => {
    const member = res.locals.learner as Learner;
    const input = profile({ ...(req.body as Fields), synthetic: "yes" });
    if (!input) {
      const [progress, published, choice] = await Promise.all([
        store.progress(member.id),
        catalog.search({}),
        store.assignmentChoice(member.id),
      ]);
      res
        .status(422)
        .send(
          dashboard(
            member,
            progress,
            res.locals.csrf as string,
            [
              "Choose valid profile, time zone and weekly time options before saving.",
            ],
            eligibleAssignments(published, member, progress),
            choice,
          ),
        );
      return;
    }
    await store.updateProfile(member.id, input);
    res.redirect(303, "/learn");
  });
  app.get("/lesson", async (_req, res) => {
    const member = res.locals.learner as Learner;
    res.send(
      lesson(
        member,
        await store.progress(member.id),
        res.locals.csrf as string,
      ),
    );
  });
  app.post("/exercise", async (req, res) => {
    const member = res.locals.learner as Learner;
    const input = submission(req.body as Fields);
    if (input.errors.length) {
      res
        .status(422)
        .send(
          lesson(
            member,
            { ...input, completed_at: null },
            res.locals.csrf as string,
            input.errors,
          ),
        );
      return;
    }
    await store.save(member.id, input);
    res.redirect(303, "/lesson");
  });
  app.post("/delete", async (req, res) => {
    if (req.body.confirm !== "yes") {
      res
        .status(422)
        .send(
          errorPage(
            "Confirm before deleting",
            "Check the confirmation box on your learning path before deleting this preview.",
          ),
        );
      return;
    }
    await evidence.removeWorkspace(res.locals.token as string);
    await store.remove((res.locals.learner as Learner).id);
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
    res.redirect(303, "/");
  });
  app.use((_req, res) =>
    res
      .status(404)
      .send(
        errorPage(
          "This page is not here",
          "Use your learning path to find the lesson and saved work.",
        ),
      ),
  );
  const failure: ErrorRequestHandler = (error, _req, res, _next) => {
    if ((error as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "invalid_evidence" });
      return;
    }
    res
      .status(503)
      .send(
        errorPage(
          "We could not save or load that",
          "We could not confirm the result. Return to your learning path to check saved work before trying again.",
        ),
      );
  };
  app.use(failure);
  return app;
}
