import type { Express, Response } from "express";
import { readableTime } from "./display-time.ts";
import type {
  MemberSharing,
  SharingSummary,
  StaffAccessEntry,
} from "./member-sharing.ts";
import { escape, page } from "./views.ts";

const PATH = "/account/sharing";
const HISTORY_PATH = `${PATH}/staff-access`;
const HISTORY_TITLE = "When staff opened my work";
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const link = (href: string, text: string) => `<a href="${href}">${text}</a>`;

function refuse(res: Response, status: number, title: string, text: string) {
  return res
    .status(status)
    .send(
      page(
        title,
        `<section class="reading"><h1>${title}</h1><p>${text}</p><p>${link("/account", "My account")}</p></section>`,
      ),
    );
}

function circleItem(circle: SharingSummary["circles"][number]) {
  const base = `/circles/${encodeURIComponent(circle.id)}/discussion`;
  const state = !circle.sharing
    ? "You joined. Discussion sharing is off, so other members can't read anything from you here."
    : circle.readablePosts
      ? `Discussion sharing is on. Other members of this circle can read ${circle.readablePosts} of your posts, under a pseudonym.`
      : "Sharing is on, but you have no posts they can read right now.";
  return `<li><strong>${escape(circle.title)}</strong><p>${state}</p><p>${link(`${base}/choice`, "Change sharing")} · ${link(`${base}/owned`, "Your contributions")}</p></li>`;
}

function reviewItems(v: SharingSummary) {
  return [
    v.evidence &&
      `<li><strong>${plural(v.evidence, "file or sample", "files or samples")} allowed for private review.</strong> A reviewer an administrator assigns can read one after you ask for review. ${link("/evidence", "Manage private evidence")}</li>`,
    v.workflowReviews &&
      `<li><strong>${plural(v.workflowReviews, "workflow note", "workflow notes")} waiting for private review.</strong> A moderator an administrator assigns can read the exact version you sent. Each reading is listed in When staff opened my work. ${link("/workflow-feedback/review", "See or withdraw requests")}</li>`,
    v.eventPermissions &&
      `<li><strong>${plural(v.eventPermissions, "event attendance permission", "event attendance permissions")}.</strong> An administrator can record whether you attended. ${link("/events/attendance", "See or withdraw permissions")}</li>`,
    v.openSupport &&
      `<li><strong>${plural(v.openSupport, "open support request", "open support requests")}.</strong> Staff assigned to a request can read it and reply. ${link("/support", "Private support")}</li>`,
  ]
    .filter(Boolean)
    .join("");
}

function contributions(v: SharingSummary, enabled: boolean) {
  if (v.publishedContributions)
    return `<p><strong>${
      v.publishedContributions === 1
        ? "1 contribution is"
        : `${v.publishedContributions} contributions are`
    } published to signed-in members,</strong> under the name you chose. ${link("/contribute", "Manage your contributions")}</p>`;
  return enabled
    ? `<p>No contributions are published. ${link("/contribute", "Your contributions")}</p>`
    : "";
}

function sharingPage(v: SharingSummary, contributionsOn: boolean) {
  const reviews = reviewItems(v);
  return `<section class="reading"><p class="eyebrow">My account</p><h1>Who can see my work</h1><p class="lead">Your work is private unless you choose to share it. This is what you're sharing right now and where to change it.</p></section>
<section class="reading" aria-labelledby="sharing-members"><h2 id="sharing-members">Other members</h2><p>Other members don't see your name, your profile or your private learning work unless you share it below.</p>${
    v.circles.length
      ? `<ul>${v.circles.map(circleItem).join("")}</ul><p>Moderators of a circle can also read its posts, and reports made about them.</p>`
      : `<p>You haven't joined a circle. ${link("/circles", "Explore circles")}</p>`
  }${contributions(v, contributionsOn)}</section>
<section class="reading" aria-labelledby="sharing-reviewers"><h2 id="sharing-reviewers">Work you sent for review</h2>${
    reviews
      ? `<ul>${reviews}</ul>`
      : `<p>You haven't sent anything for review. ${link("/support", "Private support")} · ${link("/evidence", "Private evidence")}</p>`
  }</section>
<section class="reading" aria-labelledby="sharing-staff"><h2 id="sharing-staff">Coaches and administrators</h2><p>${
    v.coaches
      ? `You have ${plural(v.coaches, "coach", "coaches")}. A coach sees your display name, monthly coaching hours and their status.`
      : "No coach is assigned to you."
  }</p><p>Account administrators see your display name, starting point, goal, coaching summary, and enrollment and billing summaries. They can also check whether an email address belongs to an account.</p><p>These pages don't show your private writing or files.</p><p>${
    v.staffWithAccess
      ? `${v.staffWithAccess === 1 ? "1 staff member has" : `${v.staffWithAccess} staff members have`} access to your private work right now, given by an administrator for a limited time.`
      : "No staff access to your private work is active right now."
  } ${link(HISTORY_PATH, HISTORY_TITLE)}</p></section>
<section class="reading" aria-labelledby="sharing-records"><h2 id="sharing-records">Your records</h2><p>${link("/member/export", "Download my records")}. To delete your account, go to ${link("/account", "My account")}.</p></section>`;
}

function accessWho(via: string | null) {
  if (via === "support") return "Support staff";
  return via === "evidence_review" ? "A reviewer" : "Assigned staff";
}
function givenWord(via: string | null) {
  return via === "evidence_review" ? "was" : "were";
}
function accessObject(via: string | null) {
  return via === "evidence_review"
    ? "one of your files"
    : "your learning workspace";
}
/** Only the member's own file name comes from stored text; it is escaped. */
function staffAccessText(entry: StaffAccessEntry) {
  const { source, action, via } = entry;
  const file = entry.file
    ? `<strong>${escape(entry.file)}</strong>`
    : "a file you've since removed";
  if (source === "access") {
    const who = accessWho(via);
    switch (action) {
      case "grant_created":
        return `${who} ${givenWord(via)} given access to ${accessObject(via)}.`;
      case "grant_revoked":
        return `Access to ${accessObject(via)} was taken away from ${who === "A reviewer" ? "a reviewer" : who.toLowerCase()}.`;
      case "workspace_read":
        return `${who} opened your learning workspace.`;
      case "support_content_read":
        return `${who} read your support content.`;
      case "evidence_link_issued":
        return `${who} got a link to ${file}.`;
      case "evidence_bytes_loaded":
        return `${who} opened ${file}.`;
    }
  }
  if (source === "feedback") {
    switch (action) {
      case "read":
        return `A reviewer read your sample ${file}.`;
      case "draft-saved":
        return `A reviewer saved draft feedback on ${file}.`;
      case "published":
        return `A reviewer published feedback on ${file}.`;
      case "answered":
        return `A reviewer answered your question about feedback on ${file}.`;
    }
  }
  if (source === "proposal") {
    const who = via === "platform_admin" ? "An administrator" : "A moderator";
    switch (action) {
      case "proposal_read":
        return `${who} read a proposal you sent.`;
      case "proposal_quarantined":
        return `${who} set aside a proposal you sent for closer review.`;
      case "proposal_rejected":
        return `${who} rejected a proposal you sent.`;
      case "proposal_changes_requested":
        return `${who} asked for changes to a proposal you sent.`;
    }
  }
  if (source === "workflow")
    return `A moderator read your workflow note for ${file}.`;
  // A later kind of record still shows rather than silently vanishing.
  return "Staff accessed your private work.";
}

function staffAccessPage(
  entries: StaffAccessEntry[],
  older: string | null,
  first: boolean,
) {
  const items = entries
    .map(
      (entry) =>
        `<li><time datetime="${entry.at.toISOString()}">${readableTime(entry.at)}</time><br>${staffAccessText(entry)}</li>`,
    )
    .join("");
  const list = items
    ? `<ul>${items}</ul>`
    : `<p role="status">${first ? "No staff access to your private work is recorded." : "There are no older entries."}</p>`;
  return `<section class="reading"><p class="eyebrow">My account</p><h1>${HISTORY_TITLE}</h1><p class="lead">Each time staff were given access to your private work, or opened it. Names aren't shown.</p>${list}${
    older
      ? `<p>${link(`${HISTORY_PATH}?before=${encodeURIComponent(older)}`, "Older entries")}</p>`
      : ""
  }</section>
<section class="reading" aria-labelledby="staff-access-covers"><h2 id="staff-access-covers">What this covers</h2><p>Your learning workspace, the files and samples you sent for review, proposals you submitted, and workflow notes you sent for private review.</p><p>Readings of workflow notes are listed from November 2026 on; earlier ones weren't recorded.</p><p>It doesn't list support requests or circle post moderation, because opening those isn't recorded here. It also doesn't list a moderator being assigned to a workflow note, or access that ended on its own at its set time.</p><p>This history is deleted with your account. It's also in ${link("/member/export", "Download my records")}. Its section there is called staffAccess.</p><p>${link(PATH, "Who can see my work")}</p></section>`;
}

/** #40 WHOSEES-01..08: read-only; every change happens on the linked page. */
export function mountMemberSharing(
  app: Express,
  store: MemberSharing | undefined,
  options: { contributions: boolean },
) {
  if (!store) return;
  app.get(HISTORY_PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { before, ...rest } = req.query;
    if (
      Object.keys(rest).length ||
      (before !== undefined && typeof before !== "string")
    )
      return refuse(res, 400, HISTORY_TITLE, "Open this page from My account.");
    const result = await store.staffAccess(
      res.locals.token as string,
      before as string | undefined,
    );
    if (result.kind === "denied") return res.redirect(303, "/");
    if (result.kind === "invalid")
      return refuse(res, 400, HISTORY_TITLE, "Open this page from My account.");
    if (result.kind !== "ready")
      return refuse(
        res,
        503,
        HISTORY_TITLE,
        "This history can't be checked right now. Try again shortly.",
      );
    return res.send(
      page(
        HISTORY_TITLE,
        staffAccessPage(
          result.value.entries,
          result.value.older,
          before === undefined,
        ),
      ),
    );
  });
  app.get(PATH, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).length)
      return refuse(
        res,
        400,
        "Who can see my work",
        "Open this page from My account.",
      );
    const result = await store.summary(res.locals.token as string);
    if (result.kind === "denied") return res.redirect(303, "/");
    if (result.kind !== "ready")
      return refuse(
        res,
        503,
        "Who can see my work",
        "Your sharing can't be checked right now. Try again shortly. Nothing you've shared has changed.",
      );
    return res.send(
      page(
        "Who can see my work",
        sharingPage(result.value, options.contributions),
      ),
    );
  });
}
