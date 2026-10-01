import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { COOKIE, COOKIE_OPTIONS, token, csrf, validCsrf } from "./session.ts";
import {
  profileStart,
  profileEdit,
  submission,
  type Fields,
} from "./validation.ts";
import {
  welcome,
  dashboard,
  privateProgressPage,
  evidencePage,
  evidenceExportPage,
  memberExportPage,
  localAiConsentPage,
  localAiControlPage,
  evidenceRevisionPage,
  lesson,
  readinessPage,
  offerHypothesesPage,
  libraryPage,
  workflowRegistryPage,
  workflowDetailPage,
  workflowFeedbackPage,
  circlesPage,
  eventDiscoveryPage,
  eventDetailPage,
  contentPreview,
  studyReflectionPage,
  privatePracticePage,
  privatePracticeHistoryPage,
  staffLibraryPage,
  trackReadinessPage,
  tailoredReviewRequestPage,
  tailoredReviewUnavailablePage,
  expertRegistryPage,
  proposalListPage,
  proposalPreviewPage,
  proposalEditRecoveryPage,
  moderationPage,
  milestonesPage,
  careerPage,
  errorPage,
  assignmentAttemptsPage,
  assignmentAttemptPage,
  assignmentComparisonPage,
  assignmentPortfolioStatement,
  assignmentWriteRecoveryPage,
  assignmentReflectionRecoveryPage,
  exerciseWriteRecoveryPage,
  starterRecordPage,
  assignmentReadinessPage,
  availabilityPage,
  sampleHoldReceiptPage,
  sampleHoldRecoveryPage,
  manualObservationPage,
} from "./views.ts";
import type { Store, Learner, Exercise, ExerciseHistory } from "./store.ts";
import { eligibleAssignments, recommendLesson } from "./assignment-choice.ts";
import {
  validPrerequisiteSpec,
  type PrerequisiteSpec,
} from "./prerequisites.ts";
import { activityItems } from "./progress.ts";
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
import {
  disabledLocalAiConsentStore,
  type LocalAiConsentStore,
} from "./local-ai-consent.ts";
import type { LocalAiControlStore } from "./local-ai-control.ts";
import { FOUNDATION_ACCESS, COACHING_OFFERS } from "./offers.ts";
import {
  disabledCatalogStore,
  type CatalogStore,
  type DraftContent,
} from "./catalog.ts";
import { disabledTrackStore, type TrackStore } from "./track-readiness.ts";
import { BACKGROUNDS, DOMAINS, GOALS, LESSON, type Domain } from "./content.ts";
import { disabledProposalStore, type ProposalStore } from "./proposals.ts";
import { workflowBundle, workflowRegistry } from "./workflow-registry.ts";
import {
  disabledWorkflowFeedbackStore,
  parseWorkflowFeedback,
  type WorkflowFeedbackStore,
} from "./workflow-feedback.ts";
import { disabledCircleStore, type CircleStore } from "./circles.ts";
import { eventPreviewDetail, listEventPreviews } from "./events.ts";
import { disabledAttemptStore, type AttemptStore } from "./attempts.ts";
import { compareResponses } from "./attempt-compare.ts";
import { disabledMetricsStore, type MetricsStore } from "./metrics.ts";
import { disabledPracticeStore, type PracticeStore } from "./practice.ts";
import {
  disabledUsefulnessStore,
  type UsefulnessChoice,
  type UsefulnessStore,
} from "./usefulness.ts";
import {
  disabledMemberExportStore,
  MAX_MEMBER_EXPORT_BYTES,
  MAX_MEMBER_EXPORT_RECORDS,
  type MemberExportStore,
} from "./member-export.ts";
import {
  disabledAvailabilityStore,
  type AvailabilityStore,
} from "./availability.ts";
import {
  disabledManualObservationStore,
  parseManualObservation,
  type ManualObservationStore,
} from "./manual-observations.ts";
import {
  disabledAssignmentReadinessStore,
  type AssignmentReadinessStore,
} from "./assignment-readiness.ts";
import {
  disabledMemberSlotHolds,
  SlotHoldFailure,
  type MemberSlotHolds,
} from "./slot-holds.ts";
const attemptWritePath =
  /^\/assignments\/attempts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(save|submit|revise)$/i;
const attemptReflectionWritePath =
  /^\/assignments\/attempts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/reflections\/(?:[1-9]|10)\/(save|delete)$/i;
const proposalEditPath = /^\/contribute\/([^/]+)\/edit$/;
function proposalAttempt(body: unknown) {
  const fields = (body ?? {}) as Fields;
  const text = (name: string, max: number) =>
    typeof fields[name] === "string"
      ? (fields[name] as string).slice(0, max)
      : "";
  return {
    title: text("title", 160),
    body: text("body", 4000),
    sources: text("sources", 1000),
  };
}
function proposalRevision(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : undefined;
}
function attemptedResponse(body: unknown, action: string) {
  const fields = (body ?? {}) as Fields;
  const value =
    action === "save"
      ? fields.response
      : action === "submit"
        ? fields.response_snapshot
        : "";
  return typeof value === "string" ? value : "";
}
function attemptedReflection(body: unknown) {
  const fields = (body ?? {}) as Fields;
  const value = (name: string) =>
    typeof fields[name] === "string" ? fields[name] : "";
  return {
    evidence: value("evidence"),
    gaps: value("gaps"),
    intention: value("intention"),
  };
}
function currentStarter(
  rows: ExerciseHistory[],
  goal: Learner["goal"],
): Exercise | undefined {
  const row = rows.find(
    (item) =>
      item.lessonId === LESSON.id &&
      item.version === LESSON.version &&
      item.goalAtStart === goal,
  );
  return row
    ? {
        instruction: row.instruction,
        verification: row.verification,
        completed_at: row.completedAt,
        withdrawn_at: row.withdrawnAt,
        goal_at_start: row.goalAtStart,
      }
    : undefined;
}

export function app(
  store: Store,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    adapters?: AdapterReadiness[];
    authorization?: AuthorizationStore;
    evidence?: EvidenceStore;
    localAiConsent?: LocalAiConsentStore;
    localAiControl?: LocalAiControlStore;
    catalog?: CatalogStore;
    tracks?: TrackStore;
    proposals?: ProposalStore;
    career?: CareerStore;
    circles?: CircleStore;
    metrics?: MetricsStore;
    attempts?: AttemptStore;
    practice?: PracticeStore;
    usefulness?: UsefulnessStore;
    workflowFeedback?: WorkflowFeedbackStore;
    memberExport?: MemberExportStore;
    availability?: AvailabilityStore;
    memberSlotHolds?: MemberSlotHolds;
    manualObservations?: ManualObservationStore;
    assignmentReadiness?: AssignmentReadinessStore;
  },
) {
  const app = express();
  const mode = options.mode ?? "demo";
  const adapters = options.adapters ?? adapterReadiness({}, mode);
  const authorization = options.authorization ?? disabledAuthorizationStore();
  const evidence = options.evidence ?? disabledEvidenceStore();
  const localAiConsent =
    options.localAiConsent ?? disabledLocalAiConsentStore();
  const localAiControl: LocalAiControlStore = options.localAiControl ?? {
    current: async () => "unavailable",
    read: async () => null,
    set: async () => false,
  };
  const catalog = options.catalog ?? disabledCatalogStore();
  const tracks = options.tracks ?? disabledTrackStore();
  const proposals = options.proposals ?? disabledProposalStore();
  const career = options.career ?? disabledCareerStore();
  const circles = options.circles ?? disabledCircleStore();
  const metrics = options.metrics ?? disabledMetricsStore();
  const attempts = options.attempts ?? disabledAttemptStore();
  const practice = options.practice ?? disabledPracticeStore();
  const usefulness = options.usefulness ?? disabledUsefulnessStore();
  const workflowFeedback =
    options.workflowFeedback ?? disabledWorkflowFeedbackStore();
  const memberExport = options.memberExport ?? disabledMemberExportStore();
  const availability = options.availability ?? disabledAvailabilityStore();
  const memberHolds = options.memberSlotHolds ?? disabledMemberSlotHolds();
  const manualObservations =
    options.manualObservations ?? disabledManualObservationStore();
  const assignmentReadiness =
    options.assignmentReadiness ?? disabledAssignmentReadinessStore();
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
    const write = attemptWritePath.exec(req.originalUrl.split("?")[0]!);
    const reflectionWrite = attemptReflectionWritePath.exec(
      req.originalUrl.split("?")[0]!,
    );
    const proposalWrite = proposalEditPath.exec(req.originalUrl.split("?")[0]!);
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      (req.get("origin") !== options.origin ||
        !validCsrf(
          req.get("x-csrf-token") ?? (req.body as Fields | undefined)?.csrf,
          session,
          options.secret,
        ))
    ) {
      if (req.get("origin") === options.origin && write) {
        res
          .status(403)
          .send(
            assignmentWriteRecoveryPage(
              "Form needs a refresh",
              "This form was not accepted. Copy your response, reopen the attempt and use the refreshed form.",
              attemptedResponse(req.body, write[2]!),
              write[1]!,
            ),
          );
        return;
      }
      if (req.get("origin") === options.origin && reflectionWrite) {
        res
          .status(403)
          .send(
            assignmentReflectionRecoveryPage(
              "Form needs a refresh",
              "This self-reflection form was not accepted. Copy your text, inspect the current attempt and use a refreshed form.",
              reflectionWrite[1]!,
              attemptedReflection(req.body),
            ),
          );
        return;
      }
      if (req.get("origin") === options.origin && proposalWrite) {
        res
          .status(403)
          .send(
            proposalEditRecoveryPage(
              proposalWrite[1]!,
              res.locals.csrf as string,
              "This form was not accepted. Copy your attempted text, then open the current private preview and use a refreshed form.",
              proposalAttempt(req.body),
            ),
          );
        return;
      }
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
  app.get("/operator/local-ai", async (_req, res) => {
    if (mode === "live") {
      res
        .status(404)
        .send(errorPage("Unavailable", "This preview is disabled."));
      return;
    }
    const state = await localAiControl.read(res.locals.token as string);
    if (!state) {
      res
        .status(403)
        .send(
          errorPage(
            "Control unavailable",
            "Platform administrator access is required.",
          ),
        );
      return;
    }
    res.send(localAiControlPage(state.paused, res.locals.csrf as string));
  });
  app.post("/operator/local-ai", async (req, res) => {
    if (mode === "live") {
      res
        .status(404)
        .send(errorPage("Unavailable", "This preview is disabled."));
      return;
    }
    const fields = req.body as Fields;
    if (
      (fields.state !== "paused" && fields.state !== "enabled") ||
      fields.confirm !== "yes"
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Control unchanged",
            "Choose and confirm an explicit local simulation state.",
          ),
        );
      return;
    }
    if (
      !(await localAiControl.set(
        res.locals.token as string,
        fields.state === "paused",
      ))
    ) {
      res
        .status(403)
        .send(
          errorPage(
            "Control unavailable",
            "Platform administrator access is required.",
          ),
        );
      return;
    }
    res.redirect(303, "/operator/local-ai");
  });
  app.get("/operator/test-receipts", async (_req, res) => {
    if (mode === "live") {
      res
        .status(404)
        .send(errorPage("Unavailable", "This preview is disabled."));
      return;
    }
    const rows = await manualObservations.list(res.locals.token as string);
    if (!rows) {
      res
        .status(403)
        .send(
          errorPage(
            "Register unavailable",
            "Platform administrator access is required.",
          ),
        );
      return;
    }
    res.send(
      manualObservationPage(rows, res.locals.csrf as string, randomUUID()),
    );
  });
  app.post("/operator/test-receipts", async (req, res) => {
    if (mode === "live") {
      res
        .status(404)
        .send(errorPage("Unavailable", "This preview is disabled."));
      return;
    }
    const input = parseManualObservation(req.body);
    if (!input) {
      res
        .status(422)
        .send(
          errorPage(
            "Observation unchanged",
            "Use invented SYN- evidence, a valid local member ID and positive integer CAD cents, then confirm the test-only action.",
          ),
        );
      return;
    }
    const result = await manualObservations.record(
      res.locals.token as string,
      input,
    );
    if (result.kind === "denied") {
      res
        .status(403)
        .send(
          errorPage(
            "Register unavailable",
            "Platform administrator access is required.",
          ),
        );
      return;
    }
    if (result.kind === "invalid" || result.kind === "member_missing") {
      res
        .status(422)
        .send(
          errorPage(
            "Observation unchanged",
            "The local member or invented observation details are unavailable.",
          ),
        );
      return;
    }
    if (result.kind === "conflict") {
      res
        .status(409)
        .send(
          errorPage(
            "Observation unchanged",
            "This test request key has already been used for different details.",
          ),
        );
      return;
    }
    res.redirect(303, "/operator/test-receipts");
  });
  app.get("/moderate/proposals", async (req, res) => {
    const continuation = req.query.after;
    const queue = await proposals.moderationPage(
      res.locals.token as string,
      continuation,
    );
    if (!queue) {
      res
        .status(403)
        .send(
          errorPage("Moderation unavailable", "Moderator access is required."),
        );
      return;
    }
    res.send(
      moderationPage(queue.items, res.locals.csrf as string, new Date(), {
        nextCursor: queue.nextCursor,
        continued: continuation !== undefined,
      }),
    );
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
  app.get(["/api/evidence/export", "/evidence/export"], async (req, res) => {
    res.set("Referrer-Policy", "no-referrer");
    const html = req.path === "/evidence/export";
    const fail = (status: number, error: string, message: string) => {
      if (html)
        res.status(status).send(errorPage("Export unavailable", message));
      else res.status(status).json({ error });
    };
    const cursor = req.query.cursor;
    if (cursor !== undefined && typeof cursor !== "string") {
      fail(
        403,
        "forbidden",
        "Export access or continuation is unavailable. Return to your private evidence and start again.",
      );
      return;
    }
    const result = await evidence.exportOwned(
      res.locals.token as string,
      cursor,
    );
    if (result.kind === "denied") {
      fail(
        403,
        "forbidden",
        "Export access or continuation is unavailable. Return to your private evidence and start again.",
      );
      return;
    }
    if (result.kind === "unavailable") {
      fail(
        503,
        "export_unavailable",
        "This live page could not be read safely. Return to your private evidence and start again.",
      );
      return;
    }
    if (html) {
      res.send(evidenceExportPage(result.page.number, cursor));
      return;
    }
    res
      .type("application/json")
      .set(
        "Content-Disposition",
        `attachment; filename="deep-native-evidence-page-${result.page.number}.json"`,
      )
      .json(result);
  });
  app.get(["/api/member/export", "/member/export"], async (req, res) => {
    res.set("Referrer-Policy", "no-referrer");
    const html = req.path === "/member/export";
    const fail = (status: number, error: string, message: string) => {
      if (html)
        res.status(status).send(errorPage("Export unavailable", message));
      else
        res
          .status(status)
          .json(status === 413 ? { error, message } : { error });
    };
    const cursor = req.query.cursor;
    if (cursor !== undefined && typeof cursor !== "string") {
      fail(
        403,
        "forbidden",
        "Export access or continuation is unavailable. Return to your learning space and start again.",
      );
      return;
    }
    const result = await memberExport.exportOwned(
      res.locals.token as string,
      cursor,
    );
    if (result.kind === "denied") {
      fail(
        403,
        "forbidden",
        "Export access or continuation is unavailable. Return to your learning space and start again.",
      );
      return;
    }
    if (result.kind === "limit") {
      fail(
        413,
        "export_limit",
        `A single record cannot fit within this preview's ${MAX_MEMBER_EXPORT_RECORDS} records and ${MAX_MEMBER_EXPORT_BYTES / 1024} KiB per-page bounds. No records from this page were returned.`,
      );
      return;
    }
    if (result.kind === "unavailable") {
      fail(
        503,
        "export_unavailable",
        "This live page could not be read safely. Return to your learning space and start again.",
      );
      return;
    }
    if (html) {
      res.send(memberExportPage(result.payload, cursor));
      return;
    }
    res
      .type("application/json")
      .set(
        "Content-Disposition",
        `attachment; filename="deep-native-member-records-page-${result.payload.page.number}.json"`,
      )
      .json(result.payload);
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
  app.post(
    "/api/evidence/:evidenceId/revoke-private-review",
    async (req, res) => {
      if (
        !(await evidence.revokePrivateReview(
          res.locals.token as string,
          req.params.evidenceId as string,
        ))
      ) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      res.status(204).end();
    },
  );
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
    const start = profileStart(req.body as Fields);
    if (!start.input) {
      res.status(422).send(welcome(res.locals.csrf as string, [], start));
      return;
    }
    await store.create(res.locals.token as string, start.input);
    res.redirect(303, "/learn");
  });
  app.use(
    [
      "/learn",
      "/progress",
      "/lesson",
      "/exercise",
      "/profile",
      "/delete",
      "/library",
      "/practice",
      "/assignments",
      "/milestones",
      "/career",
      "/contribute",
      "/evidence",
      "/circles",
      "/events",
      "/tailored-review",
      "/availability",
      "/workflow-feedback",
    ],
    async (req, res, next) => {
      const session = await store.session(res.locals.token as string);
      if (session.kind !== "active") {
        const write =
          req.method === "POST"
            ? attemptWritePath.exec(req.originalUrl.split("?")[0]!)
            : null;
        const reflectionWrite =
          req.method === "POST"
            ? attemptReflectionWritePath.exec(req.originalUrl.split("?")[0]!)
            : null;
        const proposalWrite =
          req.method === "POST"
            ? proposalEditPath.exec(req.originalUrl.split("?")[0]!)
            : null;
        if (write) {
          res
            .status(401)
            .send(
              assignmentWriteRecoveryPage(
                session.kind === "expired"
                  ? "Session expired"
                  : "Session unavailable",
                "No write was accepted. Copy your response before starting a fresh preview session; the previous private attempt cannot be reopened from a new session.",
                attemptedResponse(req.body, write[2]!),
                write[1]!,
              ),
            );
          return;
        }
        if (reflectionWrite) {
          res
            .status(401)
            .send(
              assignmentReflectionRecoveryPage(
                session.kind === "expired"
                  ? "Session expired"
                  : "Session unavailable",
                "No reflection write was accepted. Copy your text before starting a fresh preview session.",
                reflectionWrite[1]!,
                attemptedReflection(req.body),
              ),
            );
          return;
        }
        if (proposalWrite) {
          res
            .status(401)
            .send(
              proposalEditRecoveryPage(
                proposalWrite[1]!,
                res.locals.csrf as string,
                "No correction was saved. Copy your attempted text before starting a fresh preview session; an expired session cannot reopen the earlier draft.",
                proposalAttempt(req.body),
              ),
            );
          return;
        }
        res.redirect(303, "/");
        return;
      }
      res.locals.learner = session.learner;
      next();
    },
  );
  app.get("/availability", async (_req, res) => {
    const member = res.locals.learner as Learner;
    const [windows, snapshot] = await Promise.allSettled([
      availability.list(),
      memberHolds.snapshot(res.locals.token as string),
    ]);
    const slots = windows.status === "fulfilled" ? windows.value : [];
    const failed =
      windows.status === "rejected" || snapshot.status === "rejected";
    res.status(failed ? 503 : 200).send(
      availabilityPage(
        slots,
        member.timezone ?? undefined,
        failed
          ? "Availability or receipts could not be checked completely. Inspect your receipts again before trying a new sample request."
          : undefined,
        {
          csrf: res.locals.csrf as string,
          requestIds: Object.fromEntries(
            slots.map((slot) => [slot.id, randomUUID()]),
          ),
          snapshot:
            snapshot.status === "fulfilled"
              ? snapshot.value
              : { grants: [], receipts: [] },
        },
      ),
    );
  });
  app.post("/availability/holds", async (req, res) => {
    const fields = (req.body ?? {}) as Fields;
    if (
      Object.keys(fields).some(
        (key) => !["csrf", "slotId", "grantId", "requestId"].includes(key),
      ) ||
      typeof fields.slotId !== "string" ||
      typeof fields.grantId !== "string" ||
      typeof fields.requestId !== "string"
    ) {
      res
        .status(422)
        .send(
          sampleHoldRecoveryPage(
            null,
            "This form was not accepted. Reopen sample availability and use its current form.",
          ),
        );
      return;
    }
    try {
      const id = await memberHolds.request(
        res.locals.token as string,
        fields.slotId,
        fields.grantId,
        fields.requestId,
      );
      res.redirect(303, `/availability/holds/${id}`);
    } catch (error) {
      const uncertain =
        !(error instanceof SlotHoldFailure) || error.code === "uncertain";
      res
        .status(uncertain ? 503 : 409)
        .send(
          sampleHoldRecoveryPage(
            /^[0-9a-f-]{36}$/i.test(fields.requestId) ? fields.requestId : null,
            uncertain
              ? "The sample hold outcome could not be confirmed. Do not assume success or failure; inspect this request's receipt and your current receipts before trying a new request."
              : "No new sample hold was created by this request. The slot, session or matching test allowance may be unavailable, or this request may conflict with an earlier one.",
          ),
        );
    }
  });
  app.post("/availability/holds/:requestId/withdraw", async (req, res) => {
    const requestId = req.params.requestId as string;
    const receiptId = /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : null;
    if (Object.keys(req.body ?? {}).some((key) => key !== "csrf")) {
      res
        .status(422)
        .send(
          sampleHoldRecoveryPage(
            receiptId,
            "This withdrawal form was not accepted. Inspect your receipt and use its current withdrawal action.",
          ),
        );
      return;
    }
    try {
      const id = await memberHolds.withdraw(
        res.locals.token as string,
        requestId,
      );
      res.redirect(303, `/availability/holds/${id}`);
    } catch (error) {
      const uncertain =
        !(error instanceof SlotHoldFailure) || error.code === "uncertain";
      res
        .status(uncertain ? 503 : 409)
        .send(
          sampleHoldRecoveryPage(
            receiptId,
            uncertain
              ? "The withdrawal outcome could not be confirmed. Do not assume success or failure; inspect this request's receipt before trying the withdrawal again."
              : "This withdrawal was not accepted. Inspect your current receipt; it may already be settled or unavailable to this session.",
          ),
        );
    }
  });
  app.get("/availability/holds/:requestId", async (req, res) => {
    const member = res.locals.learner as Learner;
    try {
      const receipt = await memberHolds.get(
        res.locals.token as string,
        req.params.requestId as string,
      );
      if (!receipt) {
        res
          .status(404)
          .send(
            sampleHoldRecoveryPage(
              null,
              "No receipt is currently visible for this request and session. An unavailable receipt alone does not confirm the outcome of an earlier write.",
            ),
          );
        return;
      }
      res.send(
        sampleHoldReceiptPage(
          receipt,
          member.timezone ?? undefined,
          res.locals.csrf as string,
        ),
      );
    } catch {
      res
        .status(503)
        .send(
          sampleHoldRecoveryPage(
            null,
            "Your receipt could not be checked. Inspect your current receipts again before trying a new request.",
          ),
        );
    }
  });
  app.get("/tailored-review", (_req, res) => {
    res.send(tailoredReviewRequestPage(res.locals.csrf as string));
  });
  app.post("/tailored-review", async (req, res) => {
    const domain = (req.body as Fields).domain;
    if (typeof domain !== "string" || !Object.hasOwn(DOMAINS, domain)) {
      res
        .status(422)
        .send(
          tailoredReviewRequestPage(res.locals.csrf as string, [
            "Choose a listed domain before checking availability. No request was accepted.",
          ]),
        );
      return;
    }
    const service = (await tracks.snapshot()).specialties.find(
      (item) => item.domain === domain && item.serviceType === "formal-review",
    );
    if (!service) {
      res
        .status(503)
        .send(
          errorPage(
            "Availability unavailable",
            "No request was accepted. Please try the local preview later.",
          ),
        );
      return;
    }
    res
      .status(409)
      .send(tailoredReviewUnavailablePage(service, domain as Domain));
  });
  app.get("/evidence", async (_req, res) => {
    res.send(
      evidencePage(
        await evidence.owned(res.locals.token as string),
        res.locals.csrf as string,
      ),
    );
  });
  app.post("/evidence", async (req, res) => {
    const fields = req.body as Fields;
    const name = typeof fields.name === "string" ? fields.name : "";
    const sample = typeof fields.sample === "string" ? fields.sample : "";
    const invalid =
      !name.trim() ||
      name.length > 200 ||
      !sample.trim() ||
      sample.length > 4000 ||
      fields.rights_confirmed !== "yes" ||
      fields.private_review_consent !== "yes";
    if (invalid) {
      res
        .status(422)
        .send(
          evidencePage(
            await evidence.owned(res.locals.token as string),
            res.locals.csrf as string,
            [
              "Enter a title and invented text, then confirm your rights and private-review consent.",
            ],
            { name, sample },
          ),
        );
      return;
    }
    const result = await evidence.upload(res.locals.token as string, {
      name,
      mediaType: "text/plain",
      data: Buffer.from(sample),
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (result.kind === "denied") {
      res
        .status(403)
        .send(errorPage("Evidence unavailable", "Refresh your session."));
      return;
    }
    if (result.kind === "invalid") {
      res
        .status(422)
        .send(
          evidencePage(
            await evidence.owned(res.locals.token as string),
            res.locals.csrf as string,
            [
              "This text sample could not be saved. Check its title and contents.",
            ],
            { name, sample },
          ),
        );
      return;
    }
    res.redirect(303, "/evidence");
  });
  app.get("/evidence/local-ai", async (_req, res) => {
    res.send(
      localAiConsentPage(
        await localAiConsent.list(res.locals.token as string),
        res.locals.csrf as string,
        [],
        await localAiControl.current(),
      ),
    );
  });
  app.post("/evidence/local-ai/:evidenceId/grant", async (req, res) => {
    if ((req.body as Fields).confirm !== "yes") {
      res
        .status(422)
        .send(
          errorPage(
            "Confirmation needed",
            "Choose the local-only permission before continuing.",
          ),
        );
      return;
    }
    const outcome = await localAiConsent.grant(
      res.locals.token as string,
      req.params.evidenceId as string,
    );
    if (outcome.kind !== "granted") {
      res
        .status(403)
        .send(
          errorPage(
            "Local simulation unavailable",
            "Refresh your evidence and check the current version and safety state.",
          ),
        );
      return;
    }
    res.redirect(303, "/evidence/local-ai");
  });
  app.post("/evidence/local-ai/:receiptId/withdraw", async (req, res) => {
    if ((req.body as Fields).confirm !== "yes") {
      res
        .status(422)
        .send(
          errorPage(
            "Confirmation needed",
            "Confirm withdrawal before continuing.",
          ),
        );
      return;
    }
    if (
      !(await localAiConsent.withdraw(
        res.locals.token as string,
        req.params.receiptId as string,
      ))
    ) {
      res
        .status(403)
        .send(
          errorPage(
            "Permission unavailable",
            "This local permission is no longer available.",
          ),
        );
      return;
    }
    res.redirect(303, "/evidence/local-ai");
  });
  app.post("/evidence/local-ai/:receiptId/queue", async (req, res) => {
    const receiptId = req.params.receiptId as string;
    const outcome = await localAiConsent.enqueue(
      res.locals.token as string,
      receiptId,
      receiptId,
    );
    if (outcome.kind !== "queued") {
      const paused = (await localAiControl.current()) === "paused";
      res
        .status(outcome.kind === "conflict" ? 409 : 403)
        .send(
          errorPage(
            "Local simulation unavailable",
            paused
              ? "Local simulations are paused. No new local job was queued."
              : "Refresh the page and check the exact-source permission.",
          ),
        );
      return;
    }
    res.redirect(303, "/evidence/local-ai");
  });
  app.post("/evidence/local-ai/:jobId/run", async (req, res) => {
    const outcome = await localAiConsent.run(
      res.locals.token as string,
      req.params.jobId as string,
    );
    if (outcome.kind !== "completed") {
      const paused = (await localAiControl.current()) === "paused";
      res
        .status(outcome.kind === "unavailable" ? 409 : 403)
        .send(
          errorPage(
            "Local simulation unavailable",
            paused
              ? "Local simulations are paused. This attempt will not retry automatically."
              : "Refresh the page. No live AI provider was contacted.",
          ),
        );
      return;
    }
    res.redirect(303, "/evidence/local-ai");
  });
  const revisionParent = async (token: string, id: string) =>
    (await evidence.owned(token)).find(
      (item) =>
        item.id === id &&
        item.mediaType === "text/plain" &&
        item.quarantineState === "clean" &&
        item.privateReviewAllowed &&
        (item.submissionStatus === "queued" ||
          item.submissionStatus === "reviewed") &&
        !item.hasRevision &&
        item.revisionNumber < 20,
    );
  app.get("/evidence/:evidenceId/revise", async (req, res) => {
    const parent = await revisionParent(
      res.locals.token as string,
      req.params.evidenceId as string,
    );
    if (!parent) {
      res
        .status(403)
        .send(
          errorPage("Revision unavailable", "This sample cannot be revised."),
        );
      return;
    }
    res.send(evidenceRevisionPage(parent, res.locals.csrf as string));
  });
  app.post("/evidence/:evidenceId/revise", async (req, res) => {
    const fields = req.body as Fields;
    const name = typeof fields.name === "string" ? fields.name : "";
    const sample = typeof fields.sample === "string" ? fields.sample : "";
    const attempted = { name, sample };
    const parent = await revisionParent(
      res.locals.token as string,
      req.params.evidenceId as string,
    );
    if (!parent) {
      res
        .status(403)
        .send(
          errorPage("Revision unavailable", "This sample cannot be revised."),
        );
      return;
    }
    if (
      !name.trim() ||
      name.length > 200 ||
      !sample.trim() ||
      sample.length > 4000 ||
      fields.rights_confirmed !== "yes" ||
      fields.private_review_consent !== "yes"
    ) {
      res
        .status(422)
        .send(
          evidenceRevisionPage(
            parent,
            res.locals.csrf as string,
            [
              "Enter invented text and confirm fresh rights and review consent. Nothing was saved.",
            ],
            attempted,
          ),
        );
      return;
    }
    const result = await evidence.upload(res.locals.token as string, {
      name,
      mediaType: "text/plain",
      data: Buffer.from(sample),
      revisesId: parent.id,
      consent: {
        rightsConfirmed: true,
        privateReview: true,
        communityPublication: false,
      },
    });
    if (result.kind !== "created") {
      res
        .status(result.kind === "invalid" ? 422 : 409)
        .send(
          evidenceRevisionPage(
            parent,
            res.locals.csrf as string,
            [
              "Revision not saved. The original or its eligibility may have changed; refresh your evidence before retrying.",
            ],
            attempted,
          ),
        );
      return;
    }
    res.redirect(303, "/evidence");
  });
  app.post("/evidence/:evidenceId/download", async (req, res) => {
    const result = await evidence.issueDownload(
      res.locals.token as string,
      req.params.evidenceId as string,
    );
    if (result.kind === "denied") {
      res
        .status(403)
        .send(errorPage("Download unavailable", "This sample is unavailable."));
      return;
    }
    res.redirect(
      303,
      `/api/evidence/${encodeURIComponent(req.params.evidenceId as string)}/download?capability=${encodeURIComponent(result.capability)}`,
    );
  });
  app.post("/evidence/:evidenceId/queue", async (req, res) => {
    if ((req.body as Fields).acknowledge !== "yes") {
      res
        .status(422)
        .send(
          evidencePage(
            await evidence.owned(res.locals.token as string),
            res.locals.csrf as string,
            [
              "Acknowledge that no qualified reviewer or response time is available in this preview.",
            ],
          ),
        );
      return;
    }
    if (
      !(await evidence.submitForReview(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res
        .status(409)
        .send(
          evidencePage(
            await evidence.owned(res.locals.token as string),
            res.locals.csrf as string,
            [
              "This sample is not eligible for the local review queue. Refresh and check its current safety, consent and submission state.",
            ],
          ),
        );
      return;
    }
    res.redirect(303, "/evidence");
  });
  app.post("/evidence/:evidenceId/revoke-private-review", async (req, res) => {
    if ((req.body as Fields).confirm !== "yes") {
      res
        .status(422)
        .send(
          errorPage(
            "Confirmation needed",
            "Confirm the consent change, then retry.",
          ),
        );
      return;
    }
    if (
      !(await evidence.revokePrivateReview(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res
        .status(403)
        .send(errorPage("Evidence unavailable", "This sample is unavailable."));
      return;
    }
    res.redirect(303, "/evidence");
  });
  app.post("/evidence/:evidenceId/delete", async (req, res) => {
    if ((req.body as Fields).confirm !== "yes") {
      res
        .status(422)
        .send(
          errorPage("Confirmation needed", "Confirm deletion, then retry."),
        );
      return;
    }
    if (
      !(await evidence.remove(
        res.locals.token as string,
        req.params.evidenceId as string,
      ))
    ) {
      res
        .status(403)
        .send(errorPage("Evidence unavailable", "This sample is unavailable."));
      return;
    }
    res.redirect(303, "/evidence");
  });
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
  app.get("/events", (req, res) => {
    const member = res.locals.learner as Learner;
    const allTopics = req.query.all === "1";
    res.send(
      eventDiscoveryPage(
        listEventPreviews(
          {
            goal: member.goal,
            domainTags: member.domainTags ?? [],
            itRoles: member.itRoles ?? [],
          },
          { allTopics },
        ),
        member.timezone,
        allTopics,
      ),
    );
  });
  app.get("/events/:id/:version", (req, res) => {
    const rawVersion = req.params.version as string;
    const version = /^[1-9][0-9]*$/.test(rawVersion) ? Number(rawVersion) : NaN;
    const detail = eventPreviewDetail(req.params.id as string, version);
    if (detail.status === "missing") {
      res
        .status(404)
        .send(
          errorPage(
            "Event version unavailable",
            "This exact event version is not in the local preview. Browse current sample events separately.",
          ),
        );
      return;
    }
    res
      .status(detail.status === "current" ? 200 : 410)
      .send(eventDetailPage(detail, (res.locals.learner as Learner).timezone));
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
  app.get("/contribute", async (req, res) => {
    const workflowId = req.query.workflow;
    const workflow =
      typeof workflowId === "string" ? await workflowBundle(workflowId) : null;
    if (workflowId !== undefined && !workflow) {
      res
        .status(404)
        .send(
          errorPage(
            "Workflow unavailable",
            "Choose a current sample workflow.",
          ),
        );
      return;
    }
    res.send(
      proposalListPage(
        await proposals.owned(res.locals.token as string),
        res.locals.csrf as string,
        workflow,
      ),
    );
  });
  app.post("/contribute", async (req, res) => {
    const fields = req.body as Fields;
    const value = (name: string) =>
      typeof fields[name] === "string" ? (fields[name] as string) : "";
    const workflow =
      Object.hasOwn(fields, "workflow_id") ||
      Object.hasOwn(fields, "workflow_version")
        ? {
            id: value("workflow_id"),
            version: /^[1-9][0-9]*$/.test(value("workflow_version"))
              ? Number(value("workflow_version"))
              : Number.NaN,
          }
        : undefined;
    const id = await proposals.createDraft(
      res.locals.token as string,
      { title: value("title"), body: value("body"), sources: value("sources") },
      fields.sample_confirmed === "yes",
      workflow,
    );
    if (!id) {
      res
        .status(422)
        .send(
          errorPage(
            "Proposal not saved",
            "Use sample information and complete every field. If this was a workflow improvement, reopen its current version before saving.",
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
    const current = proposal.workflowId
      ? await workflowBundle(proposal.workflowId)
      : null;
    res.send(
      proposalPreviewPage(
        proposal,
        res.locals.csrf as string,
        !proposal.workflowId || current?.version === proposal.workflowVersion,
      ),
    );
  });
  app.post("/contribute/:id/edit", async (req, res) => {
    const fields = (req.body ?? {}) as Fields;
    const attempted = proposalAttempt(fields);
    const revision = proposalRevision(fields.revision);
    const permitted = new Set(["csrf", "revision", "title", "body", "sources"]);
    const malformed = Object.keys(fields).some((key) => !permitted.has(key));
    const textValid = [
      [fields.title, 160],
      [fields.body, 4000],
      [fields.sources, 1000],
    ].every(
      ([value, max]) =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= (max as number),
    );
    if (revision === undefined || malformed || !textValid) {
      res
        .status(422)
        .send(
          proposalEditRecoveryPage(
            req.params.id as string,
            res.locals.csrf as string,
            "Complete the title, original sample and sources notes within their limits. Use one value per field and reopen the current preview if its revision is missing or changed. No correction was saved.",
            attempted,
            revision,
          ),
        );
      return;
    }
    let result: Awaited<ReturnType<ProposalStore["editDraft"]>>;
    try {
      result = await proposals.editDraft(
        res.locals.token as string,
        req.params.id as string,
        attempted,
        revision,
      );
    } catch {
      res
        .status(503)
        .send(
          proposalEditRecoveryPage(
            req.params.id as string,
            res.locals.csrf as string,
            "Saving could not be confirmed. Copy your attempted text and open the current preview to check the saved revision before trying again.",
            attempted,
            undefined,
            true,
          ),
        );
      return;
    }
    if (result === "saved") {
      res.redirect(303, `/contribute/${req.params.id}`);
      return;
    }
    if (result === "denied") {
      res
        .status(404)
        .send(
          errorPage(
            "Proposal unavailable",
            "Only an active owner can correct a current private draft.",
          ),
        );
      return;
    }
    res
      .status(result === "invalid" ? 422 : 409)
      .send(
        proposalEditRecoveryPage(
          req.params.id as string,
          res.locals.csrf as string,
          result === "conflict"
            ? "The saved draft changed after this form opened. Nothing was saved. Open the current private preview before choosing what to keep."
            : "The correction fields or revision could not be accepted, or this workflow version is no longer current. Nothing was saved. Check the field limits and open the current private preview before trying again.",
          attempted,
        ),
      );
  });
  app.post("/contribute/:id/submit", async (req, res) => {
    const fields = (req.body ?? {}) as Fields;
    const revision = proposalRevision(fields.revision);
    if (
      revision === undefined ||
      Object.keys(fields).some(
        (key) => !["csrf", "revision", "rights_confirmed"].includes(key),
      ) ||
      (fields.rights_confirmed !== undefined &&
        fields.rights_confirmed !== "yes")
    ) {
      res
        .status(409)
        .send(
          proposalEditRecoveryPage(
            req.params.id as string,
            res.locals.csrf as string,
            "Submission needs one valid saved revision and explicit rights confirmation. Nothing was submitted.",
            { title: "", body: "", sources: "" },
          ),
        );
      return;
    }
    const result = await proposals.submit(
      res.locals.token as string,
      req.params.id as string,
      fields.rights_confirmed === "yes",
      revision,
    );
    if (result !== "submitted") {
      res
        .status(409)
        .send(
          proposalEditRecoveryPage(
            req.params.id as string,
            res.locals.csrf as string,
            result === "conflict"
              ? "The saved draft changed after this submission form opened. Nothing was submitted. Review the current private preview and confirm rights for its revision."
              : "Confirm original rights and check the current draft state. Nothing was submitted.",
            { title: "", body: "", sources: "" },
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
  app.get("/workflow-feedback/:id", async (req, res) => {
    const id = req.params.id as string;
    const [item, reports] = await Promise.all([
      workflowBundle(id),
      workflowFeedback.list(res.locals.token as string),
    ]);
    if (reports === null) {
      res
        .status(403)
        .send(
          errorPage(
            "Feedback unavailable",
            "Your private feedback is unavailable.",
          ),
        );
      return;
    }
    const own = reports.filter((report) => report.workflowId === id);
    if (!item && own.length === 0) {
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
    res.send(workflowFeedbackPage(item, own, res.locals.csrf as string, id));
  });
  app.post("/workflow-feedback/:id/save", async (req, res) => {
    const fields = req.body as Fields;
    const version = Number(fields.workflow_version);
    const revision = Number(fields.revision);
    const note = parseWorkflowFeedback(fields.note);
    if (
      fields.confirm !== "yes" ||
      !note ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Feedback not saved",
            "Enter 1–1,000 characters of invented private feedback and confirm your intent.",
          ),
        );
      return;
    }
    const saved = await workflowFeedback.save(
      res.locals.token as string,
      req.params.id as string,
      version,
      note,
      revision,
    );
    if (saved === "uncertain") {
      res
        .status(503)
        .send(
          errorPage(
            "Feedback save unconfirmed",
            "We could not confirm whether your note was saved. Reopen the workflow and check your current note before trying again.",
          ),
        );
      return;
    }
    if (!saved) {
      res
        .status(409)
        .send(
          errorPage(
            "Feedback unchanged",
            "Nothing was saved. Reopen the workflow and check its current version and your note before trying again.",
          ),
        );
      return;
    }
    res.redirect(303, `/workflow-feedback/${req.params.id}`);
  });
  app.post("/workflow-feedback/:id/withdraw", async (req, res) => {
    const fields = req.body as Fields;
    const version = Number(fields.workflow_version);
    const revision = Number(fields.revision);
    if (
      fields.confirm !== "yes" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Feedback unchanged",
            "Confirm withdrawal from your private note.",
          ),
        );
      return;
    }
    if (
      !(await workflowFeedback.withdraw(
        res.locals.token as string,
        req.params.id as string,
        version,
        revision,
      ))
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Feedback unchanged",
            "Nothing was removed. Reopen your private note to check its current state.",
          ),
        );
      return;
    }
    res.redirect(303, `/workflow-feedback/${req.params.id}`);
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
    const requestedVersion = req.query.version;
    if (
      requestedVersion !== undefined &&
      (typeof requestedVersion !== "string" ||
        !/^[1-9][0-9]*$/.test(requestedVersion) ||
        Number(requestedVersion) !== item.version)
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Content version unavailable",
            "That exact published version is no longer current. Return to your learning path to check its prerequisites again.",
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
  app.get("/practice", async (_req, res) => {
    res.send(
      privatePracticeHistoryPage(
        await practice.history(res.locals.token as string),
        res.locals.csrf as string,
      ),
    );
  });
  app.post("/practice/:id/:version/withdraw", async (req, res) => {
    const id = req.params.id as string;
    const rawVersion = req.params.version as string;
    const version = Number(rawVersion);
    if (
      !/^[A-Z]{2,5}-[0-9]{3}$/.test(id) ||
      !/^[1-9][0-9]*$/.test(rawVersion) ||
      !Number.isSafeInteger(version) ||
      version > 2_147_483_647
    ) {
      res
        .status(404)
        .send(
          errorPage(
            "Practice note unavailable",
            "No owned note matches that exact version.",
          ),
        );
      return;
    }
    const fields = (req.body ?? {}) as Fields;
    if (
      typeof fields.csrf !== "string" ||
      fields.confirm !== "yes" ||
      Object.keys(fields).some((key) => key !== "csrf" && key !== "confirm")
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Confirm withdrawal",
            "Open private practice history and confirm the exact note you want to withdraw.",
          ),
        );
      return;
    }
    try {
      const result = await practice.withdraw(
        res.locals.token as string,
        id,
        version,
      );
      if (result === "unavailable") {
        res
          .status(404)
          .send(
            errorPage(
              "Practice note unavailable",
              "No owned note matches that exact version.",
            ),
          );
        return;
      }
      res.redirect(303, "/practice");
    } catch {
      res
        .status(503)
        .send(
          errorPage(
            "Withdrawal outcome unknown",
            "The storage result could not be confirmed. Open private practice history and inspect this exact version before trying again.",
          ),
        );
    }
  });
  app.get("/library/:id/practice", async (req, res) => {
    const source = await practice.current(
      res.locals.token as string,
      req.params.id as string,
    );
    if (!source) {
      res
        .status(404)
        .send(
          errorPage(
            "Practice source unavailable",
            "This lesson is not currently eligible for your goal. Your saved notes, if any, remain in private practice history.",
          ),
        );
      return;
    }
    res.send(privatePracticePage(source, res.locals.csrf as string));
  });
  app.post("/library/:id/practice", async (req, res) => {
    const fields = req.body as Fields;
    const source = await practice.current(
      res.locals.token as string,
      req.params.id as string,
    );
    if (!source) {
      res
        .status(409)
        .send(
          errorPage(
            "Practice source unavailable",
            "Return to your private practice history. This lesson is not currently eligible for a new note or feedback.",
          ),
        );
      return;
    }
    const version = Number(fields.content_version);
    if (!Number.isSafeInteger(version) || version !== source.version) {
      res
        .status(409)
        .send(
          errorPage(
            "Practice source changed",
            "Reopen the current lesson before saving a note. Your earlier version was not overwritten.",
          ),
        );
      return;
    }
    const response = fields.response;
    if (
      typeof response !== "string" ||
      response.trim().length === 0 ||
      response.length > 1000 ||
      fields.synthetic !== "yes"
    ) {
      res
        .status(422)
        .send(
          privatePracticePage(
            source,
            res.locals.csrf as string,
            "Write 1 to 1,000 characters using only invented or sample information, then confirm the saving checkbox.",
            typeof response === "string" ? response.slice(0, 1000) : "",
          ),
        );
      return;
    }
    const result = await practice.save(
      res.locals.token as string,
      source.id,
      version,
      response.trim(),
    );
    if (result === "unavailable") {
      res
        .status(409)
        .send(
          errorPage(
            "Practice source changed",
            "The source changed before your note was saved. Return to private practice history or reopen the current lesson.",
          ),
        );
      return;
    }
    if (result === "conflict") {
      res
        .status(409)
        .send(
          errorPage(
            "A note already exists",
            "This lesson version accepts one private note. Return to the practice page to see the saved response; it was not overwritten.",
          ),
        );
      return;
    }
    if (result === "withdrawn") {
      res
        .status(409)
        .send(
          errorPage(
            "Practice note withdrawn",
            "This lesson version has a withdrawn marker and cannot accept another note. Inspect private practice history before trying another version.",
          ),
        );
      return;
    }
    res.redirect(303, `/library/${encodeURIComponent(source.id)}/practice`);
  });
  app.get("/library/:id/study", async (req, res) => {
    const item = await catalog.published(req.params.id as string);
    if (
      !item ||
      item.kind !== "lesson" ||
      item.state !== "published" ||
      item.requiresQualifiedSignoff
    ) {
      res
        .status(404)
        .send(
          errorPage(
            "Study source unavailable",
            "Return to the learning library for a current published sample lesson.",
          ),
        );
      return;
    }
    const member = res.locals.learner as Learner;
    res.send(studyReflectionPage(item, member.goal, res.locals.csrf as string));
  });
  app.post("/library/:id/study", async (req, res) => {
    const fields = req.body as Fields;
    const version = Number(fields.content_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      res
        .status(422)
        .send(
          errorPage(
            "Invalid study reflection",
            "Return to the current lesson and reopen the study reflection form.",
          ),
        );
      return;
    }
    const item = await catalog.published(req.params.id as string);
    if (
      !item ||
      item.kind !== "lesson" ||
      item.state !== "published" ||
      item.requiresQualifiedSignoff ||
      item.version !== version
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Study source changed",
            "This lesson version is unavailable. Return to the learning library and open the current published version.",
          ),
        );
      return;
    }
    const member = res.locals.learner as Learner;
    const reflection = fields.reflection;
    if (
      typeof reflection !== "string" ||
      reflection.trim().length === 0 ||
      reflection.length > 1000 ||
      fields.synthetic !== "yes"
    ) {
      res
        .status(422)
        .send(
          studyReflectionPage(
            item,
            member.goal,
            res.locals.csrf as string,
            null,
            "Write a reflection of at most 1,000 characters using only invented or sample information, then confirm the sample-information checkbox.",
          ),
        );
      return;
    }
    res.send(
      studyReflectionPage(
        item,
        member.goal,
        res.locals.csrf as string,
        reflection.trim(),
      ),
    );
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
      `/library/${encodeURIComponent(req.params.id as string)}?version=${version}`,
    );
  });
  app.get("/editor/library", async (_req, res) => {
    const items = await catalog.staffList(res.locals.token as string);
    if (items === null) {
      res
        .status(403)
        .send(
          errorPage(
            "Staff workflow unavailable",
            "A current editor or reviewer identity is required.",
          ),
        );
      return;
    }
    res.send(staffLibraryPage(items, res.locals.csrf as string));
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
    const reject = async (message: string) => {
      const items = await catalog.staffList(res.locals.token as string);
      if (items === null) {
        res
          .status(422)
          .send(
            errorPage(
              "Draft not saved",
              "A current editor identity is required to create synthetic content.",
            ),
          );
        return;
      }
      res
        .status(422)
        .send(
          staffLibraryPage(items, res.locals.csrf as string, fields, [message]),
        );
    };
    const tags = (name: string, choices: object): string[] | null => {
      const raw = fields[name];
      if (raw === undefined) return [];
      const values = Array.isArray(raw) ? raw : [raw];
      if (
        values.length > Object.keys(choices).length ||
        values.some(
          (item) => typeof item !== "string" || !Object.hasOwn(choices, item),
        ) ||
        new Set(values).size !== values.length
      )
        return null;
      return values as string[];
    };
    const malformedTagKey = Object.keys(fields).some((name) =>
      /^(?:goals|backgrounds|domains)(?:\[|\.)/.test(name),
    );
    const goals = tags("goals", GOALS);
    const backgrounds = tags("backgrounds", BACKGROUNDS);
    const domains = tags("domains", DOMAINS);
    if (malformedTagKey || !goals || !backgrounds || !domains) {
      await reject(
        "Choose unique, listed audience tags. Remove unknown or repeated values and try again.",
      );
      return;
    }
    let structuredPrerequisites: PrerequisiteSpec | undefined;
    if (value("structured_prerequisites").trim()) {
      try {
        const parsed: unknown = JSON.parse(value("structured_prerequisites"));
        if (!validPrerequisiteSpec(parsed))
          throw new Error("Invalid prerequisite contract");
        structuredPrerequisites = parsed;
      } catch {
        await reject(
          "Use valid versioned prerequisite JSON with published synthetic references.",
        );
        return;
      }
    }
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
      goals,
      backgrounds,
      domains,
      prerequisites: value("prerequisites"),
      structuredPrerequisites,
      minimumExperience: (value("minimum_experience") ||
        "new") as DraftContent["minimumExperience"],
      rubric: value("rubric").trim() ? value("rubric") : null,
      rubricVersion: value("rubric_version").trim()
        ? Number(value("rubric_version"))
        : null,
    };
    if (!(await catalog.createDraft(res.locals.token as string, draft))) {
      await reject(
        "Check the fields, rubric and its positive whole-number version, prerequisite references, next version and editor access.",
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
    const [progress, published, choice, activity, readiness] =
      await Promise.all([
        store.progress(member.id),
        catalog.search({}),
        store.assignmentChoice(member.id),
        store.lessonActivities(member.id),
        assignmentReadiness.list(res.locals.token as string),
      ]);
    if (readiness === null) {
      res
        .status(503)
        .send(
          errorPage(
            "Learning path unavailable",
            "Your prerequisite status could not be checked. Try opening your learning path again; nothing was changed.",
          ),
        );
      return;
    }
    res.send(
      dashboard(
        member,
        progress,
        res.locals.csrf as string,
        [],
        eligibleAssignments(published, member, progress, activity),
        choice,
        recommendLesson(published, member, progress, activity),
        undefined,
        readiness,
      ),
    );
  });
  app.get("/assignments/readiness/:id", async (req, res) => {
    const rawVersion = req.query.version;
    if (
      typeof rawVersion !== "string" ||
      !/^[1-9][0-9]*$/.test(rawVersion) ||
      !Number.isSafeInteger(Number(rawVersion))
    ) {
      res
        .status(404)
        .send(
          errorPage(
            "Assignment unavailable",
            "Open a current sample assignment from your learning path.",
          ),
        );
      return;
    }
    const readiness = await assignmentReadiness.get(
      res.locals.token as string,
      req.params.id as string,
      Number(rawVersion),
    );
    if (!readiness) {
      res
        .status(404)
        .send(
          errorPage(
            "Assignment unavailable",
            "This exact sample assignment is not available for your current direction.",
          ),
        );
      return;
    }
    res.send(assignmentReadinessPage(readiness, res.locals.csrf as string));
  });
  app.get("/progress", async (_req, res) => {
    const member = res.locals.learner as Learner;
    const [lessons, memberAttempts, reports] = await Promise.all([
      store.lessonActivities(member.id),
      attempts.list(res.locals.token as string),
      usefulness.list(res.locals.token as string),
    ]);
    if (memberAttempts === null) {
      res
        .status(403)
        .send(
          errorPage("Progress unavailable", "Open your learning path again."),
        );
      return;
    }
    const html = await store.withExerciseRead(
      res.locals.token as string,
      (rows) =>
        privateProgressPage(
          activityItems(
            currentStarter(rows, member.goal),
            lessons,
            memberAttempts,
            rows,
          ),
          reports,
          res.locals.csrf as string,
        ),
    );
    if (html === null) {
      res
        .status(403)
        .send(
          errorPage("Progress unavailable", "Open your learning path again."),
        );
      return;
    }
    res.send(html);
  });
  app.post("/library/:id/usefulness", async (req, res) => {
    const fields = req.body as Fields;
    const contentVersion = Number(fields.content_version);
    const revision = Number(fields.revision);
    const action = fields.intent;
    const choice = fields.choice;
    if (
      !Number.isSafeInteger(contentVersion) ||
      contentVersion < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      fields.confirm !== "yes" ||
      (action !== "save" && action !== "withdraw") ||
      (action === "save" && choice !== "helpful" && choice !== "not_yet") ||
      (action === "withdraw" && revision < 1)
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Usefulness response not saved",
            "Choose a response and confirm it uses only sample information, or reopen your private activity to withdraw a saved answer.",
          ),
        );
      return;
    }
    const saved =
      action === "save"
        ? await usefulness.save(
            res.locals.token as string,
            req.params.id as string,
            contentVersion,
            choice as UsefulnessChoice,
            revision,
          )
        : await usefulness.withdraw(
            res.locals.token as string,
            req.params.id as string,
            contentVersion,
            revision,
          );
    if (saved === null) {
      res
        .status(403)
        .send(
          errorPage(
            "Usefulness response unavailable",
            "This private action is not available.",
          ),
        );
      return;
    }
    if (!saved) {
      res
        .status(409)
        .send(
          errorPage(
            "Usefulness response changed",
            "Nothing was saved. This lesson or answer may have changed. Reopen your private learning activity to see the current state.",
          ),
        );
      return;
    }
    res.redirect(303, "/progress");
  });
  app.post("/assignments/select", async (req, res) => {
    const member = res.locals.learner as Learner;
    const fields = req.body as Fields;
    const id = typeof fields.content_id === "string" ? fields.content_id : "";
    const version = Number(fields.content_version);
    const [progress, activity] = await Promise.all([
      store.progress(member.id),
      store.lessonActivities(member.id),
    ]);
    const options = eligibleAssignments(
      await catalog.search({}),
      member,
      progress,
      activity,
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
  app.get("/assignments/attempts", async (_req, res) => {
    const items = await attempts.list(res.locals.token as string);
    if (items === null) {
      res
        .status(403)
        .send(
          errorPage(
            "Assignment history unavailable",
            "Open your learning path again.",
          ),
        );
      return;
    }
    res.send(assignmentAttemptsPage(items));
  });
  app.post("/assignments/attempts/start", async (_req, res) => {
    const id = await attempts.start(res.locals.token as string);
    if (!id) {
      res
        .status(409)
        .send(
          errorPage(
            "Attempt unavailable",
            "Choose an eligible, current published sample from your learning path.",
          ),
        );
      return;
    }
    res.redirect(303, `/assignments/attempts/${id}`);
  });
  const attemptId = (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  const attemptRevision = (value: unknown) => {
    const revision =
      typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0;
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  };
  const reflectionRevision = (value: unknown) => {
    const revision =
      typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : null;
    return revision !== null && Number.isSafeInteger(revision)
      ? revision
      : null;
  };
  const reflectionSequence = (value: string) =>
    /^(?:[1-9]|10)$/.test(value) ? Number(value) : null;
  app.get("/assignments/attempts/:id", async (req, res) => {
    const id = req.params.id as string;
    const item = attemptId(id)
      ? await attempts.detail(res.locals.token as string, id)
      : null;
    const linkedSubmission =
      req.query.version !== undefined || req.query.submission !== undefined;
    const validLink =
      !linkedSubmission ||
      (req.query.version === String(item?.contentVersion) &&
        typeof req.query.submission === "string" &&
        /^(?:[1-9]|10)$/.test(req.query.submission) &&
        item?.submissions?.some(
          (entry) => entry.sequence === Number(req.query.submission),
        ));
    if (!item || !validLink) {
      res
        .status(404)
        .send(
          errorPage(
            "Attempt unavailable",
            "Open one of your own saved attempts.",
          ),
        );
      return;
    }
    res.send(assignmentAttemptPage(item, res.locals.csrf as string));
  });
  app.post(
    "/assignments/attempts/:id/reflections/:sequence/save",
    async (req, res) => {
      const id = req.params.id as string;
      const sequence = reflectionSequence(req.params.sequence as string);
      const item = attemptId(id)
        ? await attempts.detail(res.locals.token as string, id)
        : null;
      const entry = item?.submissions?.find(
        (candidate) => candidate.sequence === sequence,
      );
      const values = attemptedReflection(req.body);
      if (!item || !entry || sequence === null) {
        res
          .status(404)
          .send(
            errorPage(
              "Reflection unavailable",
              "Open an owned submitted version from your private attempts.",
            ),
          );
        return;
      }
      const fields = req.body as Fields;
      const revision = reflectionRevision(fields.reflection_revision);
      const validText =
        Object.values(values).every((value) => value.length <= 1000) &&
        Object.values(values).some((value) => value.trim().length > 0);
      if (
        revision === null ||
        !validText ||
        fields.sample_confirmed !== "yes"
      ) {
        res
          .status(422)
          .send(
            assignmentAttemptPage(
              item,
              res.locals.csrf as string,
              "Enter at least one self-reflection field, keep each field within 1,000 characters and confirm sample information. Nothing was saved.",
              undefined,
              false,
              { sequence, ...values },
            ),
          );
        return;
      }
      if (
        !(await attempts.saveReflection(
          res.locals.token as string,
          id,
          sequence,
          revision,
          values,
        ))
      ) {
        const latest = await attempts.detail(res.locals.token as string, id);
        if (!latest) {
          res
            .status(409)
            .send(
              assignmentReflectionRecoveryPage(
                "Reflection unavailable",
                "The attempt or session is no longer available. Copy your text before leaving.",
                id,
                values,
              ),
            );
          return;
        }
        res
          .status(409)
          .send(
            assignmentAttemptPage(
              latest,
              res.locals.csrf as string,
              "This reflection changed in another tab or was deleted. Nothing was saved. Copy your attempted text, then reload the current state.",
              undefined,
              false,
              { sequence, ...values, conflict: true },
            ),
          );
        return;
      }
      res.redirect(303, `/assignments/attempts/${id}#submission-${sequence}`);
    },
  );
  app.post(
    "/assignments/attempts/:id/reflections/:sequence/delete",
    async (req, res) => {
      const id = req.params.id as string;
      const sequence = reflectionSequence(req.params.sequence as string);
      const item = attemptId(id)
        ? await attempts.detail(res.locals.token as string, id)
        : null;
      const entry = item?.submissions?.find(
        (candidate) => candidate.sequence === sequence,
      );
      if (!item || !entry || sequence === null) {
        res
          .status(404)
          .send(
            errorPage(
              "Reflection unavailable",
              "Open an owned submitted version from your private attempts.",
            ),
          );
        return;
      }
      const fields = req.body as Fields;
      const revision = reflectionRevision(fields.reflection_revision);
      if (fields.confirm !== "yes" || revision === null || revision === 0) {
        res
          .status(422)
          .send(
            assignmentAttemptPage(
              item,
              res.locals.csrf as string,
              "Confirm deletion of the current reflection version. Nothing was deleted.",
            ),
          );
        return;
      }
      if (
        !(await attempts.deleteReflection(
          res.locals.token as string,
          id,
          sequence,
          revision,
        ))
      ) {
        const latest = await attempts.detail(res.locals.token as string, id);
        res
          .status(409)
          .send(
            latest
              ? assignmentAttemptPage(
                  latest,
                  res.locals.csrf as string,
                  "The reflection changed or was already deleted. Reload the current state before trying again.",
                )
              : errorPage(
                  "Deletion not confirmed",
                  "Inspect your private attempts to check whether the record remains.",
                ),
          );
        return;
      }
      res.redirect(303, `/assignments/attempts/${id}#submission-${sequence}`);
    },
  );
  app.get("/assignments/attempts/:id/portfolio/:sequence", async (req, res) => {
    const id = req.params.id as string;
    const sequence = req.params.sequence as string;
    const item =
      attemptId(id) && /^(?:[1-9]|10)$/.test(sequence)
        ? await attempts.detail(res.locals.token as string, id)
        : null;
    const entry = item?.submissions?.find(
      (saved) => saved.sequence === Number(sequence),
    );
    if (!item || !entry) {
      res
        .status(404)
        .send(
          errorPage(
            "Statement unavailable",
            "Choose a retained submitted version from one of your own private attempts.",
          ),
        );
      return;
    }
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="simulated-portfolio-submission-${entry.sequence}.html"`,
    );
    res.type("html").send(assignmentPortfolioStatement(item, entry));
  });
  app.get("/assignments/attempts/:id/compare", async (req, res) => {
    const id = req.params.id as string;
    const item = attemptId(id)
      ? await attempts.detail(res.locals.token as string, id)
      : null;
    if (!item) {
      res
        .status(404)
        .send(
          errorPage(
            "Attempt unavailable",
            "Open one of your own saved attempts.",
          ),
        );
      return;
    }
    const selector = (value: unknown) =>
      typeof value === "string" && /^(?:[1-9]|10)$/.test(value)
        ? Number(value)
        : null;
    const from = selector(req.query.from);
    const to = selector(req.query.to);
    const submissions = item.submissions ?? [];
    if (
      from === null ||
      to === null ||
      from === to ||
      !submissions.some((entry) => entry.sequence === from) ||
      !submissions.some((entry) => entry.sequence === to)
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Choose two submissions",
            "Choose two different saved submission versions from your private attempt, then compare again.",
          ),
        );
      return;
    }
    const first = submissions.find((entry) => entry.sequence === from)!;
    const second = submissions.find((entry) => entry.sequence === to)!;
    res.send(
      assignmentComparisonPage(
        item,
        from,
        to,
        compareResponses(first.response, second.response),
      ),
    );
  });
  app.post("/assignments/attempts/:id/save", async (req, res) => {
    const id = req.params.id as string;
    const fields = req.body as Fields;
    const response = typeof fields.response === "string" ? fields.response : "";
    const revision = attemptRevision(fields.revision);
    const item = attemptId(id)
      ? await attempts.detail(res.locals.token as string, id)
      : null;
    if (!item) {
      res
        .status(409)
        .send(
          assignmentWriteRecoveryPage(
            "Attempt unavailable",
            "The attempt or session is no longer available. Copy your response before returning to your learning path.",
            response,
            id,
          ),
        );
      return;
    }
    if (
      revision === null ||
      response.length > 4000 ||
      fields.sample_confirmed !== "yes"
    ) {
      res
        .status(422)
        .send(
          assignmentAttemptPage(
            item,
            res.locals.csrf as string,
            "Use a valid revision, at most 4,000 characters, and confirm sample information. Nothing was saved.",
            response,
          ),
        );
      return;
    }
    if (
      !(await attempts.save(res.locals.token as string, id, revision, response))
    ) {
      const latest = await attempts.detail(res.locals.token as string, id);
      if (!latest) {
        res
          .status(409)
          .send(
            assignmentWriteRecoveryPage(
              "Attempt unavailable",
              "The attempt or session is no longer available. Copy your response before returning to your learning path.",
              response,
              id,
            ),
          );
        return;
      }
      const reason = latest.submittedAt
        ? "This attempt was already submitted. Your newer text was not saved."
        : !latest.currentEligible
          ? "The assignment or your learning direction changed. Your newer text was not saved."
          : latest.revision !== revision
            ? "Another tab saved a newer revision. Your text was not saved."
            : "The attempt could not be changed. Your text was not saved.";
      res
        .status(409)
        .send(
          assignmentAttemptPage(
            latest,
            res.locals.csrf as string,
            reason,
            response,
            true,
          ),
        );
      return;
    }
    res.redirect(303, `/assignments/attempts/${id}`);
  });
  app.post("/assignments/attempts/:id/submit", async (req, res) => {
    const id = req.params.id as string;
    const fields = req.body as Fields;
    const revision = attemptRevision(fields.revision);
    const item = attemptId(id)
      ? await attempts.detail(res.locals.token as string, id)
      : null;
    if (!item) {
      res
        .status(409)
        .send(
          errorPage(
            "Attempt unchanged",
            "Open one of your own saved attempts.",
          ),
        );
      return;
    }
    if (revision === null || fields.confirm !== "yes") {
      res
        .status(422)
        .send(
          assignmentAttemptPage(
            item,
            res.locals.csrf as string,
            "Confirm the current saved version before submitting. Nothing was submitted.",
          ),
        );
      return;
    }
    if (!item.savedAt || item.response.trim().length < 20) {
      res
        .status(422)
        .send(
          assignmentAttemptPage(
            item,
            res.locals.csrf as string,
            "Save at least 20 characters before submitting. Nothing was submitted.",
          ),
        );
      return;
    }
    if (!(await attempts.submit(res.locals.token as string, id, revision))) {
      const latest = await attempts.detail(res.locals.token as string, id);
      if (!latest) {
        res
          .status(409)
          .send(
            assignmentWriteRecoveryPage(
              "Attempt unavailable",
              "The attempt or session is no longer available. Check the current state before trying again.",
              attemptedResponse(fields, "submit"),
              id,
            ),
          );
        return;
      }
      const reason = latest.submittedAt
        ? "This saved version was already submitted locally. No second submission was created."
        : !latest.currentEligible
          ? "The assignment or your learning direction changed. Nothing was submitted."
          : latest.revision !== revision
            ? "Another tab saved a newer revision. Nothing was submitted."
            : "Save at least 20 characters before submitting. Nothing was submitted.";
      res
        .status(409)
        .send(
          assignmentAttemptPage(
            latest,
            res.locals.csrf as string,
            reason,
            undefined,
            true,
          ),
        );
      return;
    }
    res.redirect(303, `/assignments/attempts/${id}`);
  });
  app.post("/assignments/attempts/:id/revise", async (req, res) => {
    const id = req.params.id as string;
    const item = attemptId(id)
      ? await attempts.detail(res.locals.token as string, id)
      : null;
    if (!item) {
      res
        .status(409)
        .send(errorPage("Attempt unchanged", "Open one of your own attempts."));
      return;
    }
    if ((req.body as Fields).confirm !== "yes") {
      res
        .status(422)
        .send(
          assignmentAttemptPage(
            item,
            res.locals.csrf as string,
            "Confirm that you want a new private draft. Nothing was changed.",
          ),
        );
      return;
    }
    if (!(await attempts.revise(res.locals.token as string, id))) {
      const latest = await attempts.detail(res.locals.token as string, id);
      if (!latest) {
        res
          .status(409)
          .send(
            errorPage("Attempt unavailable", "Open one of your own attempts."),
          );
        return;
      }
      const reason = !latest.currentEligible
        ? "This assignment or your direction changed. No revision was started."
        : (latest.submissionCount ?? 0) >= 10
          ? "This local preview reached its ten-submission limit. Earlier work remains private and readable."
          : "This attempt changed in another tab. Reload it before starting another revision.";
      res
        .status(409)
        .send(
          assignmentAttemptPage(
            latest,
            res.locals.csrf as string,
            reason,
            undefined,
            true,
          ),
        );
      return;
    }
    res.redirect(303, `/assignments/attempts/${id}`);
  });
  app.post("/assignments/attempts/:id/delete", async (req, res) => {
    const id = req.params.id as string;
    if (!attemptId(id) || (req.body as Fields).confirm !== "yes") {
      res
        .status(409)
        .send(
          errorPage(
            "Attempt unchanged",
            "Confirm deletion of one of your own attempts.",
          ),
        );
      return;
    }
    if (!(await attempts.remove(res.locals.token as string, id))) {
      res
        .status(409)
        .send(
          errorPage(
            "Deletion not confirmed",
            "Open your attempts to check whether this record remains before trying again.",
          ),
        );
      return;
    }
    res.redirect(303, "/assignments/attempts");
  });
  const milestoneDenied = (res: express.Response) =>
    res
      .status(403)
      .send(
        errorPage(
          "Milestones unavailable",
          "Your private milestones are unavailable. Return to your learning space.",
        ),
      );
  app.get("/milestones", async (_req, res) => {
    const member = res.locals.learner as Learner;
    const rows = await store.milestones(member.id);
    if (rows === null) {
      milestoneDenied(res);
      return;
    }
    res.send(milestonesPage(member, rows, res.locals.csrf as string));
  });
  app.post("/milestones", async (req, res) => {
    const member = res.locals.learner as Learner;
    const parsed = parseMilestone(req.body as Fields, member.timezone);
    if (parsed.errors.length) {
      const rows = await store.milestones(member.id);
      if (rows === null) {
        milestoneDenied(res);
        return;
      }
      res
        .status(422)
        .send(
          milestonesPage(
            member,
            rows,
            res.locals.csrf as string,
            parsed.errors,
            parsed.input,
          ),
        );
      return;
    }
    const result = await store.createMilestone(member.id, parsed.input);
    if (result === null) {
      milestoneDenied(res);
      return;
    }
    if (!result) {
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
      const rows = await store.milestones(member.id);
      if (rows === null) {
        milestoneDenied(res);
        return;
      }
      res
        .status(422)
        .send(
          milestonesPage(
            member,
            rows,
            res.locals.csrf as string,
            parsed.errors,
            parsed.input,
            id,
          ),
        );
      return;
    }
    const result = await store.updateMilestone(
      member.id,
      id,
      version,
      parsed.input,
    );
    if (result === null) {
      milestoneDenied(res);
      return;
    }
    if (!result) {
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
    const valid = !(
      fields.confirm !== "yes" ||
      !validMilestoneId(id) ||
      !Number.isSafeInteger(version) ||
      version < 1
    );
    const result = valid
      ? await store.deleteMilestone(member.id, id, version)
      : false;
    if (result === null) {
      milestoneDenied(res);
      return;
    }
    if (!result) {
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
  const careerDenied = (res: express.Response) =>
    res
      .status(403)
      .send(
        errorPage(
          "Career planning unavailable",
          "Your private career planning is unavailable. Return to your learning path.",
        ),
      );
  app.get("/career", async (_req, res) => {
    const member = res.locals.learner as Learner;
    const snapshot = await career.snapshot(member.id);
    if (!snapshot) {
      careerDenied(res);
      return;
    }
    res.send(careerPage(snapshot, res.locals.csrf as string));
  });
  const careerChanged = (res: express.Response, result: boolean | null) => {
    if (result === null) {
      careerDenied(res);
      return false;
    }
    if (!result) {
      careerConflict(res);
      return false;
    }
    return true;
  };
  app.post("/career/enable", async (req, res) => {
    const member = res.locals.learner as Learner;
    if ((req.body as Fields).confirm !== "yes") {
      careerConflict(res);
      return;
    }
    if (!careerChanged(res, await career.enable(member.id))) return;
    res.redirect(303, "/career");
  });
  app.post("/career/disable", async (req, res) => {
    const member = res.locals.learner as Learner;
    if ((req.body as Fields).confirm !== "yes") {
      careerConflict(res);
      return;
    }
    if (!careerChanged(res, await career.disable(member.id))) return;
    res.redirect(303, "/career");
  });
  app.post("/career/entries", async (req, res) => {
    const member = res.locals.learner as Learner;
    const parsed = parseCareerEntry(req.body as Fields);
    if (parsed.errors.length) {
      const snapshot = await career.snapshot(member.id);
      if (!snapshot) {
        careerDenied(res);
        return;
      }
      res.status(422).send(
        careerPage(snapshot, res.locals.csrf as string, parsed.errors, {
          entry: parsed.input,
        }),
      );
      return;
    }
    if (!careerChanged(res, await career.createEntry(member.id, parsed.input)))
      return;
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
      const snapshot = await career.snapshot(member.id);
      if (!snapshot) {
        careerDenied(res);
        return;
      }
      res.status(422).send(
        careerPage(snapshot, res.locals.csrf as string, parsed.errors, {
          entry: parsed.input,
          editEntryId: id,
        }),
      );
      return;
    }
    if (
      !careerChanged(
        res,
        await career.updateEntry(member.id, id, version, parsed.input),
      )
    )
      return;
    res.redirect(303, "/career");
  });
  app.post("/career/entries/:id/delete", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if ((req.body as Fields).confirm !== "yes" || version === null) {
      careerConflict(res);
      return;
    }
    if (!careerChanged(res, await career.deleteEntry(member.id, id, version)))
      return;
    res.redirect(303, "/career");
  });
  app.post("/career/drafts", async (req, res) => {
    const member = res.locals.learner as Learner;
    const parsed = parseCareerDraft(req.body as Fields);
    if (parsed.errors.length) {
      const snapshot = await career.snapshot(member.id);
      if (!snapshot) {
        careerDenied(res);
        return;
      }
      res.status(422).send(
        careerPage(snapshot, res.locals.csrf as string, parsed.errors, {
          professional: parsed.input,
        }),
      );
      return;
    }
    if (!careerChanged(res, await career.createDraft(member.id, parsed.input)))
      return;
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
      const snapshot = await career.snapshot(member.id);
      if (!snapshot) {
        careerDenied(res);
        return;
      }
      res.status(422).send(
        careerPage(snapshot, res.locals.csrf as string, parsed.errors, {
          professional: parsed.input,
          editDraftId: id,
        }),
      );
      return;
    }
    if (
      !careerChanged(
        res,
        await career.updateDraft(member.id, id, version, parsed.input),
      )
    )
      return;
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/approve", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if ((req.body as Fields).confirm !== "yes" || version === null) {
      careerConflict(res);
      return;
    }
    if (!careerChanged(res, await career.approveDraft(member.id, id, version)))
      return;
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/revoke", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if ((req.body as Fields).confirm !== "yes" || version === null) {
      careerConflict(res);
      return;
    }
    if (!careerChanged(res, await career.revokeDraft(member.id, id, version)))
      return;
    res.redirect(303, "/career");
  });
  app.post("/career/drafts/:id/delete", async (req, res) => {
    const member = res.locals.learner as Learner;
    const id = req.params.id as string;
    const version = careerVersion(id, req.body as Fields);
    if ((req.body as Fields).confirm !== "yes" || version === null) {
      careerConflict(res);
      return;
    }
    if (!careerChanged(res, await career.deleteDraft(member.id, id, version)))
      return;
    res.redirect(303, "/career");
  });
  app.post("/profile", async (req, res) => {
    const member = res.locals.learner as Learner;
    const edit = profileEdit(req.body as Fields);
    if (!edit.input) {
      const [progress, published, choice, activity, readiness] =
        await Promise.all([
          store.progress(member.id),
          catalog.search({}),
          store.assignmentChoice(member.id),
          store.lessonActivities(member.id),
          assignmentReadiness.list(res.locals.token as string),
        ]);
      if (readiness === null) {
        res
          .status(503)
          .send(
            errorPage(
              "Learning path unavailable",
              "Your prerequisite status could not be checked. Nothing was changed.",
            ),
          );
        return;
      }
      res
        .status(422)
        .send(
          dashboard(
            member,
            progress,
            res.locals.csrf as string,
            [],
            eligibleAssignments(published, member, progress, activity),
            choice,
            recommendLesson(published, member, progress, activity),
            edit,
            readiness,
          ),
        );
      return;
    }
    await store.updateProfile(member.id, edit.input);
    res.redirect(303, "/learn");
  });
  app.get("/lesson", async (req, res) => {
    const member = res.locals.learner as Learner;
    const requested = req.query.version;
    const version =
      typeof requested === "string" && /^[1-9]\d*$/.test(requested)
        ? Number(requested)
        : null;
    if (
      requested !== undefined &&
      (!version || !Number.isSafeInteger(version) || version > 2147483647)
    ) {
      res
        .status(404)
        .send(
          errorPage(
            "Exercise version unavailable",
            "Open your private activity to find a retained version.",
          ),
        );
      return;
    }
    const goal = req.query.goal;
    if (
      goal !== undefined &&
      (typeof goal !== "string" ||
        !["everyday", "work", "build", "unattributed"].includes(goal) ||
        version === null)
    ) {
      res
        .status(404)
        .send(
          errorPage(
            "Exercise version unavailable",
            "Open your private activity to find an exact retained record.",
          ),
        );
      return;
    }
    const html = await store.withExerciseRead(
      res.locals.token as string,
      (rows) => {
        if (version !== null) {
          const matches = rows.filter(
            (row) =>
              row.lessonId === LESSON.id &&
              row.version === version &&
              (goal === undefined ||
                (row.goalAtStart ?? "unattributed") === goal),
          );
          return matches.length === 1
            ? starterRecordPage(matches[0]!, res.locals.csrf as string)
            : null;
        }
        return lesson(
          member,
          currentStarter(rows, member.goal),
          res.locals.csrf as string,
          [],
          rows,
        );
      },
    );
    if (html === null) {
      res
        .status(version === null ? 403 : 404)
        .send(
          errorPage(
            version === null
              ? "Lesson unavailable"
              : "Exercise version unavailable",
            version === null
              ? "Open your learning path again."
              : "That exact retained version is unavailable. Open your private activity to inspect what remains.",
          ),
        );
      return;
    }
    res.send(html);
  });
  app.post("/exercise", async (req, res) => {
    const member = res.locals.learner as Learner;
    const form = req.body as Fields;
    if (
      form.lesson_id !== LESSON.id ||
      form.lesson_version !== String(LESSON.version) ||
      form.goal !== member.goal
    ) {
      res
        .status(409)
        .send(
          errorPage(
            "Exercise form out of date",
            "Open the current lesson before saving. An older form cannot be moved to a new version or a different goal.",
          ),
        );
      return;
    }
    const input = submission(form);
    if (input.errors.length) {
      const html = await store.withExerciseRead(
        res.locals.token as string,
        (rows) =>
          currentStarter(rows, member.goal)?.withdrawn_at
            ? null
            : lesson(
                member,
                { ...input, completed_at: null },
                res.locals.csrf as string,
                input.errors,
                rows,
              ),
      );
      if (html === null) {
        res
          .status(409)
          .send(
            errorPage(
              "Exercise text withdrawn",
              "The saved text cannot be restored. Open your lesson to inspect the retained completion.",
            ),
          );
        return;
      }
      res.status(422).send(html);
      return;
    }
    try {
      const outcome = await store.save(member.id, {
        ...input,
        goal: member.goal,
      });
      if (outcome === "stale-goal" || outcome === "unavailable") {
        res
          .status(409)
          .send(
            errorPage(
              "Exercise form out of date",
              "Your direction or session changed. Open your learning path and the current lesson before saving.",
            ),
          );
        return;
      }
      if (outcome === "withdrawn") {
        res
          .status(409)
          .send(
            errorPage(
              "Exercise text withdrawn",
              "The saved text cannot be restored. Open your lesson to inspect the retained completion.",
            ),
          );
        return;
      }
    } catch {
      let recovery: string | null = null;
      try {
        recovery = await store.withExerciseRead(
          res.locals.token as string,
          (rows) =>
            currentStarter(rows, member.goal)?.withdrawn_at
              ? null
              : exerciseWriteRecoveryPage(
                  input.instruction,
                  input.verification,
                  member.goal,
                ),
        );
      } catch {
        // The write outcome is uncertain and private state could not be read.
      }
      res
        .status(503)
        .send(
          recovery ??
            errorPage(
              "Save outcome unknown",
              "The storage result could not be confirmed. Open your lesson to inspect the current state before trying again.",
            ),
        );
      return;
    }
    res.redirect(303, "/lesson");
  });
  app.post("/exercise/:lessonId/:version/withdraw", async (req, res) => {
    const { lessonId, version } = req.params;
    const parsedVersion = Number(version);
    if (
      lessonId !== LESSON.id ||
      !/^[1-9]\d*$/.test(version) ||
      !Number.isSafeInteger(parsedVersion) ||
      parsedVersion > 2147483647
    ) {
      res
        .status(404)
        .send(
          errorPage(
            "Exercise unavailable",
            "Open your lesson to find saved work.",
          ),
        );
      return;
    }
    const fields = req.body as Fields;
    if (
      fields.confirm !== "yes" ||
      Object.keys(fields).some(
        (key) => key !== "csrf" && key !== "confirm" && key !== "goal",
      ) ||
      (fields.goal !== undefined &&
        (typeof fields.goal !== "string" ||
          !["everyday", "work", "build", "unattributed"].includes(fields.goal)))
    ) {
      res
        .status(422)
        .send(
          errorPage(
            "Confirm withdrawal",
            "Check the confirmation box on your lesson before withdrawing saved text.",
          ),
        );
      return;
    }
    let outcome: Awaited<ReturnType<Store["withdrawExercise"]>>;
    try {
      outcome = await store.withdrawExercise(
        res.locals.token as string,
        lessonId,
        parsedVersion,
        fields.goal as import("./store.ts").ExerciseGoal | undefined,
      );
    } catch {
      res
        .status(503)
        .send(
          errorPage(
            "Withdrawal outcome unknown",
            "The storage result could not be confirmed. Open your lesson to inspect the current state.",
          ),
        );
      return;
    }
    if (outcome === "unavailable") {
      res
        .status(404)
        .send(
          errorPage(
            "Exercise unavailable",
            "Open your lesson to find saved work.",
          ),
        );
      return;
    }
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
  const failure: ErrorRequestHandler = (error, req, res, _next) => {
    if ((error as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "invalid_evidence" });
      return;
    }
    if (req.method === "POST" && req.path === "/delete") {
      res
        .status(503)
        .send(
          errorPage(
            "Deletion status unconfirmed",
            "We could not confirm completion. If the request was accepted, local cleanup will retry; this page is not a deletion receipt.",
          ),
        );
      return;
    }
    const write =
      req.method === "POST"
        ? attemptWritePath.exec(req.originalUrl.split("?")[0]!)
        : null;
    const reflectionWrite =
      req.method === "POST"
        ? attemptReflectionWritePath.exec(req.originalUrl.split("?")[0]!)
        : null;
    if (write) {
      res
        .status(503)
        .send(
          assignmentWriteRecoveryPage(
            write[2] === "save"
              ? "Save outcome unknown"
              : write[2] === "submit"
                ? "Submission outcome unknown"
                : "Revision outcome unknown",
            "The storage result could not be confirmed. Copy your response, then reload this attempt and check its current state before trying again.",
            attemptedResponse(req.body, write[2]!),
            write[1]!,
          ),
        );
      return;
    }
    if (reflectionWrite) {
      res
        .status(503)
        .send(
          assignmentReflectionRecoveryPage(
            "Reflection outcome unknown",
            "The storage result could not be confirmed. Copy your text, then inspect the current saved attempt before trying again.",
            reflectionWrite[1]!,
            attemptedReflection(req.body),
          ),
        );
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
