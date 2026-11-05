import type { Express, Response } from "express";
import type { MemberSharing, SharingSummary } from "./member-sharing.ts";
import { escape, page } from "./views.ts";

const PATH = "/account/sharing";
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
      `<li><strong>${plural(v.workflowReviews, "workflow note", "workflow notes")} waiting for private review.</strong> A moderator an administrator assigns can read the exact version you sent. ${link("/workflow-feedback/review", "See or withdraw requests")}</li>`,
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
  }</p><p>Account administrators see your display name, starting point, goal, coaching summary, and enrollment and billing summaries. They can also check whether an email address belongs to an account.</p><p>These pages don't show your private writing or files.</p></section>
<section class="reading" aria-labelledby="sharing-records"><h2 id="sharing-records">Your records</h2><p>${link("/member/export", "Download my records")}. To delete your account, go to ${link("/account", "My account")}.</p></section>`;
}

/** #40 WHOSEES-01..08: read-only; every change happens on the linked page. */
export function mountMemberSharing(
  app: Express,
  store: MemberSharing | undefined,
  options: { contributions: boolean },
) {
  if (!store) return;
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
