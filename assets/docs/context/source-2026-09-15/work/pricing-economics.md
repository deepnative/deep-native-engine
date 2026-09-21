# Commercial and financial plan draft

All amounts are CAD before applicable sales taxes. Every proposed price, cost, conversion rate, retention rate and acquisition rate is a planning hypothesis, not validated willingness to pay. The initial audience is individual independent IT contractors across roles. Membership intake is broad; a paid role-specific service is sold only when a qualified expert and suitable assessment are available.

## Offer architecture and pricing

The commercial unit is one individual contractor. Launch only the CAD3,000 pilot and CAD12,000 annual Professional program. Display CAD24,000 Specialist, CAD48,000 Practice and CAD120,000 Partner as future invitation-only service designs, not purchasable or validated products. The high tier is substantial managed support for an established solo practice whose bottleneck can justify the cost. It cannot be justified merely by adding courses.

| Offer | Annual price | Monthly reserved human capacity, including preparation | Monthly AI / infrastructure allowance | Direct monthly cost at full clinic utilization | Indicative gross margin |
|---|---:|---|---:|---:|---:|
| Professional | 12,000 | Coach1h; domain reviewer0.5h; support0.5h; pooled clinics0.25h allocated | 25 / 15 | 330.55 | 66.9% |
| Specialist | 24,000 | Coach2h; reviewer1h; implementation1h; support1h; clinics0.25h | 45 / 20 | 739.55 | 63.0% |
| Practice | 48,000 | Coach3h; reviewer2h; engineer3h; support2h; clinics0.25h | 100 / 30 | 1,522.55 | 61.9% |
| Partner | 120,000 | Coach4h; senior adviser2h; reviewer4h; engineer12h; analyst8h; support4h; clinics0.25h | 250 / 75 | 4,826.55 | 51.7% |

Loaded human cost assumptions: coach and implementation CAD125/hour, qualified domain review and engineering150/hour, senior adviser200/hour, analyst80/hour, support60/hour. Reserved hours include preparation, review, corrections and follow-up. Professional's1h coach budget supports a45-minute call plus15minutes preparation;0.5h domain review supports20minutes review plus10minutes preparation. Do not silently promise full billable hours plus unpaid preparation.

Four general60-minute clinics run per month per group of at most16 members, at CAD500/group/month. A full group implies31.25 per member, but the forecast uses whole groups and therefore shows lower margin at small scale. These are cross-role general clinics, not a claim that one mentor has expertise in every role. Individual domain review must be routed by verified expertise. Additional role-specific group sessions require new cost assumptions.

Direct cost estimates include the stated human time, AI usage allowance, infrastructure allowance, pooled clinics and an illustrative payment fee of2.9% plus0.30 per charge. They exclude onboarding and fixed content production, mentor sourcing, product development, administration and customer acquisition. Renewal Professional revenue is1,000/month. Conversion service revenue is900/month, making its gross margin lower than the normalized renewal-tier illustration. AI and processor rates are budget allowances, not vendor quotations. Annual prepayment reduces fixed transaction fees but not percentage fees.

## Pilot and first-year contract

- Standalone pilot: CAD3,000 for the first two billing months, with the core instruction delivered over eight weeks. It includes an assessment, personalized plan, one substantial approved portfolio assignment, two45-minute coaching calls, four bounded domain reviews across the pilot, two AI mock interviews with feedback, one maintained workflow, and access to scheduled group clinics. Human-led interview feedback consumes the stated coaching/review quota.
- Pilot capacity budget per month: coach1h, qualified reviewer1h, support1h, AI35, infrastructure15. One-time onboarding: coach1h plus support0.5h =155. Clinic costs are shared by actual group count.
- A graduate accepts the CAD12,000 first-year program. The pilot is months1–2 of that same12month service term. The remaining ten months cost CAD9,000, payable once or in ten CAD900 installments. The initial3,000 is counted once. There is no second12month term attached to this credit.
- Renewal is a new12month term at CAD12,000 or twelve1,000 installments at the same annual total. Installments are a collection schedule, not an ordinary month-to-month cancellable subscription.
- Exact cancellation, cooling-off, renewal, accessibility and refund terms must be reviewed for the customer's jurisdiction before charging. The model conservatively assumes approved early release/default stops future recognition and refunds unused prepaid service value. These are economics assumptions, not drafted legal rights.
- The planning model recognizes the pilot evenly over two months and the remaining service evenly over ten. Accounting treatment must be confirmed if distinct service obligations require a different allocation. Cash collected in advance is a service liability, not immediately earned revenue.
- All unused-prepay refunds retain original processing fees as a cost. Pilot refund allowance reduces the cohort eligible to convert. Delivery staffing for refunded pilot seats is retained in the model as a conservative cost assumption.

## Model structure

`financial-model.json` provides independently calculated monthly results. The workbook uses the same assumptions with native formulas and one active case. M1–M12 means months from the decision to start, not an assumed calendar launch date. Starts begin M3 after two preparation months. Counts of retained members are expected values and can be fractional; actual operating rosters must use whole people. Only the pilot and Professional are forecast. No higher-tier sales are included to make the forecast profitable.

Monthly cohort formulas for pilot starting in month s, with n paid starts:

1. Eligible graduates = n × (1 − pilot refund rate) × conversion rate.
2. Active pilot seats in month m = starts[m] + starts[m−1].
3. For service ages2–11, active members = eligible graduates × (1 − approved early-release rate)^(age−2). Before age2, no continuing member exists.
4. Prepay cash at conversion = new graduates × prepay share ×9,000. Installment cash = active members × (1−prepay share) ×900.
5. Refund of unused prepay after early release = members immediately before release × release rate × prepay share × remaining service months ×900.
6. Recognized revenue = active pilot seats ×1,500 ×(1−pilot refund rate) + active members ×900.
7. Deferred revenue closing = opening deferred + net customer collections − recognized revenue.
8. Operating result = recognized revenue − direct service costs − acquisition spending − fixed operating expenses.
9. Net cash flow = net customer collections − direct service costs − acquisition spending − fixed operating expenses. All modeled costs are assumed paid in month.
10. Cash closing = opening cash + net cash flow. Cash less deferred = closing cash − closing unearned service balance.

No customers reach their first annual renewal within the modeled year. Annual renewal assumptions60%/75%/80% are research hypotheses for a later model extension, not drivers of Year1 revenue and not observed retention. Do not calculate lifetime value from an untested renewal assumption.

## Scenarios and calculated results

| Metric | Downside | Base | Capacity |
|---|---:|---:|---:|
| Pilot starts in Year1 | 15 | 37 | 82 |
| Pilot conversion after refunds | 35% | 60% | 70% |
| Pilot refund assumption | 8% | 3% | 2% |
| Monthly approved early release / default | 2.5% | 1.0% | 0.5% |
| Remaining-term prepay share | 25% | 50% | 60% |
| Acquisition cost per paid pilot | 1,200 | 900 | 700 |
| Recognized revenue | 57,744 | 159,768 | 362,128 |
| Net customer collections | 61,778 | 206,468 | 509,179 |
| Direct service costs | 25,700 | 63,266 | 139,360 |
| Gross margin | 55.5% | 60.4% | 61.5% |
| Acquisition spending | 18,000 | 33,300 | 57,400 |
| Fixed operating expenses | 123,000 | 123,000 | 123,000 |
| Operating profit / (loss) | (108,956) | (59,798) | 42,368 |
| Closing deferred service balance | 4,034 | 46,700 | 147,052 |
| M12 active continuing members | 3.50 | 15.21 | 39.21 |
| M12 active pilot seats | 3 | 10 | 24 |
| M12 annualized continuing-member revenue | 37,772 | 164,229 | 423,507 |
| Minimum peak-deficit funding +15k buffer | 119,922 | 62,012 | 52,798 |
| Funding +15k buffer while protecting all deferred receipts | 123,956 | 80,840 | 61,780 |

Fixed Year1 expense: founder management72,000 (6,000/month), ongoing content/mentor sourcing18,000 (1,500/month), engineering25,500 (4,000/month in M1–M3, then1,500/month), startup7,500 in M1. The CAD72,000 founder allowance covers operation and management; service delivery is assumed to be purchased from experts. If the founder supplies service hours, allocate that compensation once between delivery and management so the same hours are not double-counted. Acquisition spending is900 per paid pilot in Base, additional to founder management time. An operating loss is not hidden by upfront collections.

The Base case needs approximately81k of committed opening funding with the full prepaid service balance protected and a15k operating buffer. This is a modeled scenario, not a fundraising requirement established by evidence. A staged pilot can be stopped or redesigned much earlier than the full-year forecast. The Capacity case is explicitly conditional on acquisition and qualified-expert supply; it is not a growth forecast or promise. Annualized M12 recurring-member revenue must not be described as realized Year1 revenue, total booked contract value or validated ARR.

## Acquisition and capacity controls

- Acquisition cost per pilot includes the assumed marketing, referral and variable selling budget. Track founder selling hours separately. A fully allocated CAC should include the relevant share of founder payroll and business development overhead.
- Base implied acquisition cost per eventual eligible graduate =900/[(1−3%)×60%] =1,546, before fixed selling overhead. Year1 acquisition divided by in-year graduates is affected by two-month cohort lag and is not the same cohort CAC.
- Capacity includes pilot onboarding, coaching preparation, domain review and group facilitation. One capacity unit is80 productive expert hours/month at80% booking, or64 committed hours. M12 Base needs55.81 expert hours, or0.87 units; Capacity needs134.82 hours, or2.11 units. These are staffing equivalents, not a claim that one generalist covers the required domains.
- Maintain an expert coverage matrix by role, domain, timezone and confidentiality permissions. Do not accept a service-level promise solely because aggregate free hours exist. Route uncovered requests to a waitlist or offer a clearly reduced deliverable before taking payment.
- Introduce a documented scope and usage ceiling for each review, call, workflow and AI task. All rework must count toward delivery cost. No unlimited expert support, unlimited agent execution or unbounded custom development.
- Stop enrollment in a service track if qualified review capacity is unavailable, backlog exceeds its promised response time, or actual gross margin repeatedly misses the tier's floor.

## Decisions and risks

1. Premium pricing must be tested through actual paid acceptance, completion and continued use. Five interviews and expressions of interest do not validate a12k annual contract.
2. Gross margin is not net margin. The Professional renewal unit looks attractive at full utilization, yet the Base first year still loses approximately60k after staffing, acquisition and setup.
3. Cash can look healthy because the service is prepaid. In Base,46.7k at year end belongs to undelivered obligations. Treat it as reserved when deciding how much cash can fund experiments.
4. Serving all IT roles broadens demand but creates an expert coverage problem. Use shared learning infrastructure plus role-specific verified reviewers; do not market universal expert coverage.
5. CAD120k individual spend is a special-case managed-service hypothesis. Require a documented commercial bottleneck, substantial ability to pay, a scoped statement of work and enough potential incremental contribution to justify the fee. Improvements in hourly productivity alone do not establish higher contractor income.
6. Keep sales taxes outside revenue and economic margin. The final tax collection/remittance workflow depends on registration, place of supply and customer jurisdiction. Corporate income tax, financing and foreign-exchange effects are excluded from this pre-tax management model.
7. Do not use fabricated outcome claims, guaranteed jobs, guaranteed billing rates, guaranteed assessment scores, or unverified expert credentials in marketing. Track causal contribution conservatively rather than assigning all customer revenue gains to the platform.
