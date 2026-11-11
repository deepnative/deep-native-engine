import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { availabilityStore } from "../../src/availability.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { COOKIE } from "../../src/session.ts";
import { memberSlotHolds } from "../../src/slot-holds.ts";
import { memberReference } from "./course-bundle-journey.ts";
import type { reviewedContentFixture } from "./reviewed-content-browser.ts";

type Fixture = Awaited<ReturnType<typeof reviewedContentFixture>>;

// A coach with a verified roster record and two open one-hour sample slots,
// and a member with one 60-minute coaching test credit, on a case's own
// reviewedContentFixture database. Sample holds are test data, never bookings.
export async function slotJourney(f: Fixture) {
  const admin = await f.staff("platform_admin"),
    operator = await f.staff("operator"),
    [coach, backup] = await Promise.all([f.staff("coach"), f.staff("coach")]);
  const record = randomUUID();
  const roster = (id: string, staffId: string, other: string) =>
    f.pool.query(
      `INSERT INTO expert_registry(id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
         loaded_cost_cents,capacity_minutes,committed_minutes,backup_staff_id,
         qualification_ref,agreement_ref,conflict_review_ref,verified_by,verified_at)
       VALUES($1,$2,'coach','education','coaching',clock_timestamp()-interval '1 hour',
         clock_timestamp()+interval '30 days',12000,300,60,$3,'INVENTED-QUAL-SLOT',
         'INVENTED-AGREE-SLOT','INVENTED-CONFLICT-SLOT',$4,clock_timestamp()-interval '1 minute')`,
      [id, staffId, other, admin.id],
    );
  await roster(record, coach.id, backup.id);
  await roster(randomUUID(), backup.id, coach.id);
  const firstStart = new Date(
    Math.floor((Date.now() + 3 * 86_400_000) / 60000) * 60000,
  );
  const starts = [firstStart, new Date(+firstStart + 7_200_000)];
  const slotIds: string[] = [];
  for (const startsAt of starts) {
    const id = await availabilityStore(f.pool).create(
      operator.token,
      record,
      startsAt,
      new Date(+startsAt + 3_600_000),
    );
    expect(id).toBeTruthy();
    slotIds.push(id!);
  }
  const member = await f.member();
  const memberId = await memberReference(member, f.origin);
  const memberToken = (await member.context().cookies()).find(
    (cookie) => cookie.name === COOKIE,
  )!.value;
  const grantId = await syntheticLedger(f.pool).grant(
    memberId,
    "coach_minutes",
    60,
    randomUUID(),
    {
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    },
  );
  return {
    admin,
    operator,
    coach,
    member,
    memberId,
    grantId,
    slotIds,
    starts,
    /** The member's own hold request with one credit; opens its receipt. */
    async hold(slotId: string, creditId: string) {
      const requestId = randomUUID();
      await memberSlotHolds(f.pool).request(
        memberToken,
        slotId,
        creditId,
        requestId,
      );
      const url = `${f.origin}/availability/holds/${requestId}`;
      await member.goto(url);
      await expect(member.locator('dt:text-is("State") + dd')).toHaveText(
        "held",
      );
      return url;
    },
    /** The member's coaching test credits, oldest first. */
    async credits() {
      return (
        await f.pool.query<{
          id: string;
          quantity: number;
          available: number;
          reserved: number;
          consumed: number;
          starts_at: Date;
          expires_at: Date;
        }>(
          `SELECT id,quantity,available,reserved,consumed,starts_at,expires_at
           FROM synthetic_entitlement_grants
           WHERE member_id=$1 AND category='coach_minutes' ORDER BY created_at,id`,
          [memberId],
        )
      ).rows;
    },
    /** One credit's ledger events, oldest first. */
    async events(creditId: string) {
      return (
        await f.pool.query<{ id: string; operation: string; quantity: number }>(
          `SELECT id,operation,quantity,reservation_id,result_id,created_at
           FROM synthetic_entitlement_events WHERE grant_id=$1 ORDER BY created_at,id`,
          [creditId],
        )
      ).rows;
    },
    /** An operator cancels the held slot on the staff page, with a reason. */
    async staffCancel(
      staff: Page,
      slotId: string,
      reason: "coach-unavailable" | "scheduling-error" | "member-request",
    ) {
      await staff.goto(f.origin + "/operator/sample-holds");
      const form = staff
        .getByRole("listitem")
        .filter({ hasText: slotId })
        .locator('form[action$="/cancel"]');
      const sent = {
        action: (await form.getAttribute("action"))!,
        fields: {
          ...(Object.fromEntries(
            await form
              .locator("input[type=hidden]")
              .evaluateAll((inputs) =>
                inputs.map((input) => [
                  (input as HTMLInputElement).name,
                  (input as HTMLInputElement).value,
                ]),
              ),
          ) as Record<string, string>),
          reason,
        },
      };
      await form.getByLabel("Reason").selectOption(reason);
      await form
        .getByRole("button", { name: "Cancel sample hold as staff" })
        .click();
      await expect(staff.getByRole("status")).toContainText(
        "Sample hold cancelled. One replacement credit was added.",
      );
      return sent;
    },
  };
}
