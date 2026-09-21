import fs from 'node:fs/promises';
export const root='/Users/tomwu/Documents/Codex/2026-09-15/i-x20';
export const common={currency:'CAD',horizon_months:12,pilot_price:3000,pilot_months:2,first_year_price:12000,remaining_months:10,remaining_price:9000,monthly_program_price:900,renewal_annual_price:12000,payment_fee_rate:0.029,payment_fee_fixed:0.30,coach_hourly:125,domain_hourly:150,support_hourly:60,group_capacity:16,group_hours_monthly:4,founder_management_monthly:6000,content_and_mentor_bench_monthly:1500,engineering_first_three_months:4000,engineering_later_monthly:1500,startup_month_one:7500,opening_cash:100000,liquidity_buffer:15000,pilot_monthly_variable:385,program_monthly_variable:270,pilot_onboarding:155,mentor_productive_hours_per_month:80,mentor_booking_target:0.8};
export const scenarios=[
 {name:'Downside',starts:[0,0,3,0,3,0,3,0,3,0,3,0],conversion:0.35,pilot_refund:0.08,early_release:0.025,prepay_share:0.25,cac:1200,annual_renewal:0.6},
 {name:'Base',starts:[0,0,5,0,5,2,3,4,4,4,5,5],conversion:0.60,pilot_refund:0.03,early_release:0.01,prepay_share:0.50,cac:900,annual_renewal:0.75},
 {name:'Capacity',starts:[0,0,5,5,6,6,8,8,10,10,12,12],conversion:0.70,pilot_refund:0.02,early_release:0.005,prepay_share:0.60,cac:700,annual_renewal:0.80}
];
export function calculate(c){
 let cash=common.opening_cash,deferred=0,cumulativeNet=0,peakDeficit=0,peakProtectedDeficit=0;
 const cohorts=c.starts.map((n,s)=>({s,n,graduates:n*(1-c.pilot_refund)*c.conversion}));
 const months=Array.from({length:12},(_,m)=>{
  const starts=c.starts[m]; const pilot=starts+(c.starts[m-1]||0);
  let members=0,newMembers=0,refunds=0;
  for(const h of cohorts){const age=m-h.s;if(age>=2&&age<=11){let active=h.graduates*Math.pow(1-c.early_release,age-2);members+=active;if(age===2)newMembers+=active;else refunds+=h.graduates*Math.pow(1-c.early_release,age-3)*c.early_release*c.prepay_share*(12-age)*common.monthly_program_price;}}
  const pilotGross=starts*common.pilot_price,pilotRefunds=pilotGross*c.pilot_refund;
  const upfrontGross=newMembers*c.prepay_share*common.remaining_price;
  const installmentGross=members*(1-c.prepay_share)*common.monthly_program_price;
  const grossCollections=pilotGross+upfrontGross+installmentGross;
  const netCollections=grossCollections-pilotRefunds-refunds;
  const revenue=pilot*common.pilot_price/2*(1-c.pilot_refund)+members*common.monthly_program_price;
  const fees=grossCollections*common.payment_fee_rate+(starts+newMembers*c.prepay_share+members*(1-c.prepay_share))*common.payment_fee_fixed;
  const groups=Math.ceil((pilot+members)/common.group_capacity);
  const groupCost=groups*common.group_hours_monthly*common.coach_hourly;
  const serviceCost=pilot*common.pilot_monthly_variable+members*common.program_monthly_variable;
  const onboarding=starts*common.pilot_onboarding;
  const cogs=serviceCost+onboarding+groupCost+fees;
  const grossProfit=revenue-cogs;
  const acquisition=starts*c.cac;
  const engineering=m<3?common.engineering_first_three_months:common.engineering_later_monthly;
  const startup=m===0?common.startup_month_one:0;
  const fixed=common.founder_management_monthly+common.content_and_mentor_bench_monthly+engineering+startup;
  const operating=grossProfit-acquisition-fixed;
  const netCash=netCollections-cogs-acquisition-fixed;
  const openingCash=cash,openingDeferred=deferred;cash+=netCash;deferred+=netCollections-revenue;cumulativeNet+=netCash;
  peakDeficit=Math.max(peakDeficit,-cumulativeNet);peakProtectedDeficit=Math.max(peakProtectedDeficit,deferred-cumulativeNet);
  const coachHours=pilot+members+starts+groups*4,domainHours=pilot+members*0.5,supportHours=pilot+members*0.5+starts*0.5;
  const mentorHours=coachHours+domainHours;
  return {month:m+1,pilot_starts:starts,pilot_active:pilot,new_members:newMembers,members_active:members,total_active:pilot+members,gross_collections:grossCollections,pilot_refunds:pilotRefunds,prepaid_unused_refunds:refunds,net_collections:netCollections,pilot_revenue:pilot*1500*(1-c.pilot_refund),program_revenue:members*900,revenue,service_cost:serviceCost,onboarding_cost:onboarding,group_count:groups,group_cost:groupCost,payment_fees:fees,cogs,gross_profit:grossProfit,acquisition_cost:acquisition,founder_management:6000,content_and_mentor_bench:1500,engineering,startup,fixed_opex:fixed,operating_result:operating,net_cash_flow:netCash,opening_cash:openingCash,closing_cash:cash,opening_deferred:openingDeferred,closing_deferred:deferred,cash_less_deferred:cash-deferred,coach_hours:coachHours,domain_hours:domainHours,support_hours:supportHours,mentor_hours:mentorHours,mentor_capacity_units:mentorHours/(80*0.8)};
 });
 const sum=k=>months.reduce((s,m)=>s+m[k],0);const end=months[11];
 const summary={pilot_starts:sum('pilot_starts'),pilot_graduates_in_year:sum('new_members'),recognized_revenue:sum('revenue'),net_collections:sum('net_collections'),direct_service_costs:sum('cogs'),gross_profit:sum('gross_profit'),gross_margin:sum('gross_profit')/sum('revenue'),acquisition_cost:sum('acquisition_cost'),fixed_opex:sum('fixed_opex'),operating_result:sum('operating_result'),net_cash_flow:sum('net_cash_flow'),closing_cash:end.closing_cash,closing_deferred_revenue:end.closing_deferred,cash_less_deferred:end.cash_less_deferred,minimum_closing_cash:Math.min(...months.map(x=>x.closing_cash)),peak_cash_deficit_before_funding:peakDeficit,minimum_funding_plus_buffer:peakDeficit+common.liquidity_buffer,protected_funding_plus_buffer:peakProtectedDeficit+common.liquidity_buffer,month12_active_members:end.members_active,month12_active_pilots:end.pilot_active,month12_annualized_member_revenue:end.program_revenue*12,month12_total_revenue_annualized:end.revenue*12,month12_mentor_hours:end.mentor_hours,month12_mentor_capacity_units:end.mentor_capacity_units,paid_pilot_cac:c.cac,implied_graduate_cac:c.cac/((1-c.pilot_refund)*c.conversion)};
 return {assumptions:c,months,summary};
}
export const tiers=[
 {name:'Professional',annual:12000,coach:1,domain:0.5,implementation:0,engineer:0,senior:0,analyst:0,support:0.5,ai:25,infra:15},
 {name:'Specialist',annual:24000,coach:2,domain:1,implementation:1,engineer:0,senior:0,analyst:0,support:1,ai:45,infra:20},
 {name:'Practice',annual:48000,coach:3,domain:2,implementation:0,engineer:3,senior:0,analyst:0,support:2,ai:100,infra:30},
 {name:'Partner',annual:120000,coach:4,domain:4,implementation:0,engineer:12,senior:2,analyst:8,support:4,ai:250,infra:75}
].map(t=>{const monthly=t.annual/12;const human=t.coach*125+t.domain*150+t.implementation*125+t.engineer*150+t.senior*200+t.analyst*80+t.support*60;const fees=monthly*0.029+0.3;const direct=human+t.ai+t.infra+31.25+fees;return {...t,monthly,human_cost:human,group_allocated_hours:0.25,group_cost:31.25,payment_fees:fees,direct_monthly_cost:direct,gross_margin:(monthly-direct)/monthly,total_reserved_human_hours:t.coach+t.domain+t.implementation+t.engineer+t.senior+t.analyst+t.support+0.25};});
export const model={created:'2026-09-15',basis:'Planning assumptions; no validated demand, historical data, or market cost quotations. Expected-value fractional people. M1-M12 from launch decision; no calendar launch date assumed.',common,tiers,scenarios:scenarios.map(calculate),notes:['Only CAD12k program and CAD3k pilot are forecast. Higher tiers are future hypotheses.','Pilot is first two billing months. Graduates add10 months for9k; the full12months totals12k.','Pilot refunds reduce revenue over two months. All original pilot capacity is conservatively retained; refunded pilots cannot convert.','Annual prepay percentage applies to9k remaining first-year balance; installments are900 monthly. Earlyrelease is approved exit/default, not monthlycancellable product.','Prepaid unused value refunded when an expected earlyrelease occurs. Processing fees are not recovered.','Revenue is ratable management-planning treatment; final allocation requires accountant review because distinct service obligations can change accounting.','Cash includes deferred service obligations and is not all free cash. Separate protected funding keeps full unearned receipts unspent.','All costs assumed paid inmonth. No accountsreceivable, financing, capex capitalization, corporateincome tax, FX, or owner distributions. Founder management6000/month cost is included. Sales taxes are pass-through and excluded from all totals.','Renewal cannot be observed in this12month model. Annual renewal inputs are hypotheses for a later extension, excluded from yearone computations.','Four general clinics per pooledgroup/month. Domain-specific individual reviews require qualified roleexperts; capacityunits do not establish skills coverage.','Third-party AI and processor costs are budgeting allowances, not verified vendor quotes.']};
await fs.mkdir(`${root}/work/finance`,{recursive:true});
await fs.writeFile(`${root}/work/financial-model.json`,JSON.stringify(model,null,2));
if(process.argv[1]?.endsWith('/model.mjs')) console.log(JSON.stringify(model.scenarios.map(x=>({name:x.assumptions.name,...x.summary})),null,2));
