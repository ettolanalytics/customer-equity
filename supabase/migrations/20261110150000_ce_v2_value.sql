-- Customer Equity · migratie 8
-- sBG-parameters, DERL, 5-year customer value, customer equity, waterfall (acht balken),
-- controles en publicatie naar ce_public.quarters_v2 / publication_v2 (nog niet live).
-- Ontwerp: docs/ontwerp-dashboard-v3.md v3.3 (lokaal) en v2 §5.
--
-- Raakt de oude pijplijn niet: ce_public.quarters/publication, de oude views en
-- refresh_and_publish() blijven ongewijzigd.
--
-- CLV van een actieve klant op kwartaaleinde q (marge van het huidige abonnement):
--   gf × m(q, abonnement) × DERL(q, segment, n)
--   gf   = 1 als betaald t/m q, anders de late-verlengfactor g(q)
--   DERL = Σ_{t=1..60} δ^t × r(n) × … × r(n+t−1),  r(j) = (β+j−1)/(α+β+j−1),  δ = 1,10^(−1/12)

-- ---------------------------------------------------------------------------
-- 1. Schattingen, validaties
-- ---------------------------------------------------------------------------
create table ce_private.sbg_runs (
  run_id        bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  load_id       bigint      not null,
  segmentation  text        not null,
  returners     text        not null,
  status        text        not null check (status in ('complete', 'failed')),
  fits          integer     not null,
  failed_fits   integer     not null,
  seconds       double precision,
  git_sha       text,
  gh_run_id     text
);
comment on table ce_private.sbg_runs is
  'Eén rij per schatting (scripts/estimate_sbg.py). Alleen een run met status complete '
  '(alle fits geconvergeerd) wordt gebruikt.';

create table ce_private.sbg_params (
  run_id     bigint           not null references ce_private.sbg_runs (run_id),
  qe         date             not null,
  segment    smallint         not null,
  alpha      double precision not null check (alpha > 0),
  beta       double precision not null check (beta > 0),
  var_log_alpha double precision,
  var_log_beta  double precision,
  cov_log       double precision,
  loglik     double precision not null,
  customers  double precision not null,
  grad       double precision not null,
  converged  boolean          not null,
  checks     jsonb            not null,
  primary key (run_id, qe, segment)
);
comment on table ce_private.sbg_params is
  'α en β per kwartaaleinde en segment (0 = terugkeerders apart, plan_id = startabonnement, '
  '−1 = samen), geschat op de data zoals bekend op dat kwartaaleinde.';

create table ce_private.validation_runs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  t           date        not null,
  as_of       date        not null,
  pass        boolean     not null,
  advice      jsonb       not null,
  results     jsonb       not null,
  git_sha     text,
  run_id      text
);
comment on table ce_private.validation_runs is
  'Uitkomsten van scripts/validate_holdout.py (V1a, V1b, V2, V3, V4 en het advies).';

-- ---------------------------------------------------------------------------
-- 2. Segment van een klantperiode (zelfde regel als sbg.segment_key in Python)
-- ---------------------------------------------------------------------------
create function ce_private.bz_segment(grp integer, start_plan integer)
returns smallint
language sql stable set search_path = ''
as $$
  select (case when s.returners = 'separate' and grp = 2 then 0
               when s.segmentation = 'start_plan' then start_plan
               else -1 end)::smallint
  from ce_private.settings_v2 s
$$;

-- Parameters van de laatste complete schatting.
create view ce_private.v_bz_params with (security_invoker = true) as
select p.qe, p.segment, p.alpha, p.beta, p.run_id
from ce_private.sbg_params p
where p.run_id = (select max(run_id) from ce_private.sbg_runs where status = 'complete');

-- ---------------------------------------------------------------------------
-- 3. DERL per kwartaaleinde, segment en klantduur
-- ---------------------------------------------------------------------------
-- L(m) = Σ_{j=1..m} ln r(j); Π_{j=n..n+t−1} r(j) = exp(L(n+t−1) − L(n−1)).
create materialized view ce_private.mv_bz_derl as
with s as (
  select horizon_months as h, power(1 + discount_rate_year, -1.0 / 12) as d from ce_private.settings_v2
), nm as (
  select max(n)::int as m from ce_private.mv_bz_state
), lr as (
  select p.qe, p.segment, g.j,
         sum(ln((p.beta + g.j - 1) / (p.alpha + p.beta + g.j - 1)))
           over (partition by p.qe, p.segment order by g.j) as l
  from ce_private.v_bz_params p
  cross join s cross join nm
  cross join generate_series(1, nm.m + s.h) as g(j)
  union all
  select p.qe, p.segment, 0, 0 from ce_private.v_bz_params p
)
select a.qe, a.segment, (a.j + 1)::smallint as n,
       sum(power(s.d, b.j - a.j) * exp(b.l - a.l)) as derl,
       sum(exp(b.l - a.l))                          as undiscounted,
       min(exp(b.l - a.l)) filter (where b.j = a.j + 1) as next_invoice
from lr a
cross join s
join lr b on b.qe = a.qe and b.segment = a.segment and b.j between a.j + 1 and a.j + s.h
cross join nm
where a.j < nm.m
group by a.qe, a.segment, a.j
with no data;
comment on materialized view ce_private.mv_bz_derl is
  'Verwachte resterende facturen per klant (verdisconteerd, max. 60) bij klantduur n, plus '
  'onverdisconteerd en de kans op de volgende factuur r(n).';

-- ---------------------------------------------------------------------------
-- 4. Waarden per paar begin/eind en de acht balken (§3.3, v2 §5)
-- ---------------------------------------------------------------------------
-- Per klantperiode: v00 = CLV aan het begin (p0, M0); a_t = klantduur van het eind, abonnement
-- en betaalstatus van het begin; s_t = ook het abonnement van het eind; e = nieuw/reacquired met
-- p0, M0; r_t = eindtoestand met p1 en M0; v11 = eindtoestand met p1 en M1 (de CE aan het eind).
-- Betaalstatus (respijt) verandert in balk 6, zodat "stayed longer" nooit negatief is.
create materialized view ce_private.mv_bz_wf_rows as
with s as (select * from ce_private.settings_v2),
q as (
  select qs, qe, (qs - 1) as q0, label from ce_private.v_bz_quarters, s
  where qs >= (s.first_param_quarter + interval '3 months')
),
sz as (select distinct plan_id, size_grams from ce_private.bz_plans)
select q.qe, p.flow, p.customers as c, p.plan1, sz0.size_grams as sz0, sz1.size_grams as sz1,
       p.customers * (case when p.pt0 then 1 else g0.g end) * m00.margin_eur * d0n0.derl as v00,
       p.customers * (case when p.pt0 then 1 else g0.g end) * m00.margin_eur * d0n1.derl as a_t,
       p.customers * (case when p.pt0 then 1 else g0.g end) * m01.margin_eur * d0n1.derl as s_t,
       p.customers * (case when p.pt1 then 1 else g0.g end) * m01.margin_eur * d0n1.derl as e,
       p.customers * (case when p.pt1 then 1 else g1.g end) * m01.margin_eur * d1n1.derl as r_t,
       p.customers * (case when p.pt1 then 1 else g1.g end) * m11.margin_eur * d1n1.derl as v11,
       p.customers * (case when p.pt1 then 1 else g1.g end) * d1n1.derl                 as inv1,
       p.customers * (case when p.pt0 then 1 else g0.g end) * d0n0.derl                 as inv0
from q
join ce_private.mv_bz_pairs p on p.qe = q.qe
left join ce_private.mv_bz_late g0 on g0.qe = q.q0
left join ce_private.mv_bz_late g1 on g1.qe = q.qe
left join ce_private.mv_bz_plan_money m00 on m00.qe = q.q0 and m00.plan_id = p.plan0
left join ce_private.mv_bz_plan_money m01 on m01.qe = q.q0 and m01.plan_id = p.plan1
left join ce_private.mv_bz_plan_money m11 on m11.qe = q.qe and m11.plan_id = p.plan1
left join ce_private.mv_bz_derl d0n0
  on d0n0.qe = q.q0 and d0n0.segment = ce_private.bz_segment(p.grp, p.start_plan) and d0n0.n = p.n0
left join ce_private.mv_bz_derl d0n1
  on d0n1.qe = q.q0 and d0n1.segment = ce_private.bz_segment(p.grp, p.start_plan) and d0n1.n = p.n1
left join ce_private.mv_bz_derl d1n1
  on d1n1.qe = q.qe and d1n1.segment = ce_private.bz_segment(p.grp, p.start_plan) and d1n1.n = p.n1
left join sz sz0 on sz0.plan_id = p.plan0
left join sz sz1 on sz1.plan_id = p.plan1
with no data;

-- Per kwartaal: aantallen, customer equity en de acht balken.
create materialized view ce_private.mv_bz_quarters as
with s as (select * from ce_private.settings_v2),
q as (select * from ce_private.v_bz_quarters, s where qs >= s.first_calc_quarter),
f as (
  select qe,
         sum(customers) filter (where flow in ('S', 'L'))      as active_begin,
         sum(customers) filter (where flow in ('S', 'N', 'R')) as active_end,
         sum(customers) filter (where flow = 'N')              as new,
         sum(customers) filter (where flow = 'R')              as reacquired,
         sum(customers) filter (where flow = 'L')              as churned,
         sum(customers) filter (where flow = 'S')              as staying,
         sum(customers) filter (where flow = 'S' and sz1 > sz0) as upgrades,
         sum(customers) filter (where flow = 'S' and sz1 < sz0) as downgrades
  from ce_private.mv_bz_pairs p
  left join (select distinct plan_id, size_grams as sz0 from ce_private.bz_plans) a on a.plan_id = p.plan0
  left join (select distinct plan_id, size_grams as sz1 from ce_private.bz_plans) b on b.plan_id = p.plan1
  group by qe
),
w as (
  select qe,
         sum(v00) filter (where flow in ('S', 'L'))                    as ce0,
         sum(v11) filter (where flow in ('S', 'N', 'R'))               as ce1,
         sum(e)   filter (where flow = 'N')                            as b_new,
         sum(e)   filter (where flow = 'R')                            as b_reacq,
         -sum(v00) filter (where flow = 'L')                           as b_lost,
         sum(a_t - v00) filter (where flow = 'S')                      as b_stayed,
         coalesce(sum(s_t - a_t) filter (where flow = 'S' and sz1 > sz0), 0) as b_up,
         coalesce(sum(s_t - a_t) filter (where flow = 'S' and sz1 < sz0), 0) as b_down,
         sum(r_t) filter (where flow in ('S', 'N', 'R'))
           - sum(s_t) filter (where flow = 'S')
           - coalesce(sum(e) filter (where flow in ('N', 'R')), 0)     as b_ret,
         sum(v11 - r_t) filter (where flow in ('S', 'N', 'R'))         as b_margin,
         sum(inv1) filter (where flow in ('S', 'N', 'R'))              as inv1,
         sum(inv0) filter (where flow in ('S', 'L'))                   as inv0
  from ce_private.mv_bz_wf_rows group by qe
),
rev as (
  select q.qe, sum(m.amount_cents)::double precision / 100 as revenue_eur
  from q join ce_private.mv_bz_month m
    on m.ps_month >= q.qs and m.ps_month <= q.qe and m.known_month <= q.qe
  group by q.qe
)
select q.qs, q.qe, q.label,
       f.active_begin::bigint, f.active_end::bigint, f.new::bigint, f.reacquired::bigint,
       f.churned::bigint, f.staying::bigint,
       coalesce(f.upgrades, 0)::bigint as upgrades, coalesce(f.downgrades, 0)::bigint as downgrades,
       f.churned::double precision / nullif(f.active_begin, 0) as churn_rate,
       lag(f.churned::double precision / nullif(f.active_begin, 0), 4) over (order by q.qe) as expected_churn_rate,
       lag(f.churned::double precision / nullif(f.active_begin, 0), 4) over (order by q.qe) * f.active_begin
                                                                         as expected_churn,
       rev.revenue_eur, g.g,
       w.ce0, w.ce1 as customer_equity, w.inv0, w.inv1,
       w.b_new, w.b_reacq, w.b_lost, w.b_stayed, w.b_up, w.b_down, w.b_ret, w.b_margin
from q
join f on f.qe = q.qe
left join w on w.qe = q.qe
left join rev on rev.qe = q.qe
left join ce_private.mv_bz_late g on g.qe = q.qe
with no data;
comment on materialized view ce_private.mv_bz_quarters is
  'Per kwartaal: klantenstroom per klantperiode, customer equity (ce1) en de acht balken '
  '(b_*), ce0 = customer equity aan het begin met de parameters van het begin.';

-- Per kwartaal en huidig abonnement: actief, customer equity.
create materialized view ce_private.mv_bz_plan_values as
select r.qe, r.plan1 as plan_id, sum(r.c)::bigint as active_end, sum(r.v11) as customer_equity
from ce_private.mv_bz_wf_rows r
where r.flow in ('S', 'N', 'R')
group by r.qe, r.plan1
with no data;

-- ---------------------------------------------------------------------------
-- 5. JSON per dashboardkwartaal (alleen getallen, kwartaallabels en structuur)
-- ---------------------------------------------------------------------------
create function ce_private.wf_json(
  from_label text, to_label text, ce0 double precision, ce1 double precision,
  n0 bigint, n1 bigint, inv0 double precision, inv1 double precision,
  b_new double precision, b_reacq double precision, b_lost double precision, b_stayed double precision,
  b_up double precision, b_down double precision, b_ret double precision, b_margin double precision,
  c_new bigint, c_reacq bigint, c_lost bigint, c_stay bigint, c_up bigint, c_down bigint
) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'fromLabel', from_label, 'toLabel', to_label,
    'equityBegin', round(ce0::numeric, 2), 'equityEnd', round(ce1::numeric, 2),
    'equityChange', round((ce1 - ce0)::numeric, 2),
    'equityChangePct', round(((ce1 - ce0) / ce0)::numeric, 6),
    'parts', jsonb_build_object(
      'newCustomers', round(b_new::numeric, 2), 'reacquiredCustomers', round(b_reacq::numeric, 2),
      'lostCustomers', round(b_lost::numeric, 2), 'stayedLonger', round(b_stayed::numeric, 2),
      'upgrades', round(b_up::numeric, 2), 'downgrades', round(b_down::numeric, 2),
      'retentionEffect', round(b_ret::numeric, 2), 'marginEffect', round(b_margin::numeric, 2)),
    'counts', jsonb_build_object(
      'newCustomers', c_new, 'reacquiredCustomers', c_reacq, 'lostCustomers', c_lost,
      'stayingCustomers', c_stay, 'upgrades', c_up, 'downgrades', c_down),
    'customersBegin', n0, 'customersEnd', n1,
    'avgClvBegin', round((ce0 / n0)::numeric, 4), 'avgClvEnd', round((ce1 / n1)::numeric, 4),
    'expectedInvoicesBegin', round((inv0 / n0)::numeric, 4),
    'expectedInvoicesEnd', round((inv1 / n1)::numeric, 4),
    'marginPerFutureInvoiceBegin', round((ce0 / inv0)::numeric, 4),
    'marginPerFutureInvoiceEnd', round((ce1 / inv1)::numeric, 4))
$$;

create materialized view ce_private.mv_bz_quarters_json as
with s as (select * from ce_private.settings_v2),
d as (
  select row_number() over (order by q.qe)::integer as seq, q.*,
         q.customer_equity / q.active_end as avg_clv,
         q.inv1 / q.active_end            as expected_invoices,
         q.customer_equity / q.inv1       as margin_future
  from ce_private.mv_bz_quarters q, s
  where q.qs >= s.first_dashboard_quarter
),
w as (
  select d.*,
         (sum(new) over l4)::bigint as new4, (sum(reacquired) over l4)::bigint as reacq4,
         (sum(churned) over l4)::bigint as churn4, (sum(staying) over l4)::bigint as stay4,
         (sum(upgrades) over l4)::bigint as up4, (sum(downgrades) over l4)::bigint as down4,
         sum(b_new) over l4 as y_new, sum(b_reacq) over l4 as y_reacq, sum(b_lost) over l4 as y_lost,
         sum(b_stayed) over l4 as y_stayed, sum(b_up) over l4 as y_up, sum(b_down) over l4 as y_down,
         sum(b_ret) over l4 as y_ret, sum(b_margin) over l4 as y_margin,
         count(expected_churn) over l4 as exp_n4,
         sum(expected_churn - churned) over l4 as cve4
  from d
  window l4 as (order by seq rows between 3 preceding and current row)
),
plans as (
  select v.qe, jsonb_agg(jsonb_build_object(
           'planId', v.plan_id, 'sizeGrams', sz.size_grams, 'activeEnd', v.active_end,
           'customerEquity', round(v.customer_equity::numeric, 2),
           'avgClv', round((v.customer_equity / v.active_end)::numeric, 4),
           'marginPerInvoice', round(m.margin_eur::numeric, 4)) order by sz.size_grams) as plans
  from ce_private.mv_bz_plan_values v
  join (select distinct plan_id, size_grams from ce_private.bz_plans) sz using (plan_id)
  join ce_private.mv_bz_plan_money m on m.qe = v.qe and m.plan_id = v.plan_id
  group by v.qe
),
model as (
  select qe, jsonb_agg(jsonb_build_object('segment', segment, 'alpha', round(alpha::numeric, 6),
                                          'beta', round(beta::numeric, 6)) order by segment) as model
  from ce_private.v_bz_params group by qe
),
ex as (
  -- Rekenvoorbeeld: een nieuwe klant (n = 1, betaald) op het abonnement waarmee de meeste
  -- nieuwe klanten in het kwartaal begonnen.
  select distinct on (p.qe) p.qe, p.plan1 as plan_id
  from ce_private.mv_bz_pairs p where p.flow = 'N'
  group by p.qe, p.plan1 order by p.qe, sum(p.customers) desc, p.plan1
),
exv as (
  select ex.qe, jsonb_build_object(
           'planId', ex.plan_id, 'sizeGrams', sz.size_grams,
           'nextInvoiceChance', round(dl.next_invoice::numeric, 6),
           'expectedInvoices', round(dl.derl::numeric, 4),
           'undiscountedInvoices', round(dl.undiscounted::numeric, 4),
           'marginPerInvoice', round(m.margin_eur::numeric, 4),
           'value', round((m.margin_eur * dl.derl)::numeric, 4)) as example
  from ex
  join (select distinct plan_id, size_grams from ce_private.bz_plans) sz using (plan_id)
  join ce_private.mv_bz_plan_money m on m.qe = ex.qe and m.plan_id = ex.plan_id
  join ce_private.mv_bz_derl dl on dl.qe = ex.qe and dl.n = 1
   and dl.segment = ce_private.bz_segment(1, ex.plan_id)
),
j as (
  select c.seq, c.label, c.qe,
         case when p.seq is not null then
           ce_private.wf_json(p.label, c.label, c.ce0, c.customer_equity, c.active_begin, c.active_end,
                              p.inv1, c.inv1, c.b_new, c.b_reacq, c.b_lost, c.b_stayed, c.b_up, c.b_down,
                              c.b_ret, c.b_margin, c.new, c.reacquired, c.churned, c.staying,
                              c.upgrades, c.downgrades) end as wf,
         case when ya.seq is not null then
           ce_private.wf_json(ya.label, c.label, ya.customer_equity, c.customer_equity, ya.active_end,
                              c.active_end, ya.inv1, c.inv1, c.y_new, c.y_reacq, c.y_lost, c.y_stayed,
                              c.y_up, c.y_down, c.y_ret, c.y_margin, c.new4, c.reacq4, c.churn4,
                              c.stay4, c.up4, c.down4) end as ywf,
         c.ce0 - coalesce(p.customer_equity, c.ce0) as ce0_vs_prev,
         c.b_new + c.b_reacq + c.b_lost + c.b_stayed + c.b_up + c.b_down + c.b_ret + c.b_margin
           - (c.customer_equity - c.ce0) as wf_deviation,
         c.y_new + c.y_reacq + c.y_lost + c.y_stayed + c.y_up + c.y_down + c.y_ret + c.y_margin
           - (c.customer_equity - ya.customer_equity) as ywf_deviation,
         c.b_stayed, c.b_up, c.b_down,
         jsonb_build_object(
           'label', c.label,
           'activeBegin', c.active_begin, 'activeEnd', c.active_end,
           'newCustomers', c.new, 'reacquiredCustomers', c.reacquired,
           'acquiredCustomers', c.new + c.reacquired, 'churn', c.churned,
           'upgrades', c.upgrades, 'downgrades', c.downgrades,
           'expectedChurn', round(c.expected_churn::numeric, 1),
           'churnRate', round(c.churn_rate::numeric, 6),
           'expectedChurnRate', round(c.expected_churn_rate::numeric, 6),
           'revenueEur', round(c.revenue_eur::numeric, 2),
           'customerEquity', round(c.customer_equity::numeric, 2),
           'avgClv', c.avg_clv,
           'expectedInvoices', c.expected_invoices,
           'marginPerFutureInvoice', c.margin_future,
           'lateRenewalFactor', round(c.g::numeric, 6),
           'plans', pl.plans, 'model', md.model, 'clvExample', exv.example)
         || jsonb_build_object(
           'equityVsPrevQuarter', ce_private.change_json(c.customer_equity, p.customer_equity),
           'equityVsYearAgo', ce_private.change_json(c.customer_equity, ya.customer_equity),
           'activeVsPrevQuarter', ce_private.change_json(c.active_end, p.active_end),
           'activeVsYearAgo', ce_private.change_json(c.active_end, ya.active_end),
           'avgClvVsPrevQuarter', ce_private.change_json(c.avg_clv, p.avg_clv),
           'avgClvVsYearAgo', ce_private.change_json(c.avg_clv, ya.avg_clv),
           'newVsPrevQuarter', ce_private.change_json(c.new, p.new),
           'newVsYearAgo', ce_private.change_json(c.new, ya.new),
           'reacquiredVsPrevQuarter', ce_private.change_json(c.reacquired, p.reacquired),
           'reacquiredVsYearAgo', ce_private.change_json(c.reacquired, ya.reacquired),
           'churnVsPrevQuarter', ce_private.change_json(c.churned, p.churned),
           'churnVsYearAgo', ce_private.change_json(c.churned, ya.churned),
           'churnRateVsPrevQuarter', ce_private.rate_change(c.churn_rate, p.churn_rate),
           'churnRateVsYearAgo', ce_private.rate_change(c.churn_rate, ya.churn_rate),
           'expectedInvoicesVsPrevQuarter', ce_private.change_json(c.expected_invoices, p.expected_invoices),
           'expectedInvoicesVsYearAgo', ce_private.change_json(c.expected_invoices, ya.expected_invoices),
           'marginPerFutureInvoiceVsPrevQuarter', ce_private.change_json(c.margin_future, p.margin_future),
           'marginPerFutureInvoiceVsYearAgo', ce_private.change_json(c.margin_future, ya.margin_future),
           'churnVsExpectedCount', round((c.churned - c.expected_churn)::numeric, 1),
           'yearSummary', case when ya.seq is not null then jsonb_build_object(
               'acquiredCustomers', c.new4 + c.reacq4, 'newCustomers', c.new4,
               'reacquiredCustomers', c.reacq4, 'churn', c.churn4,
               'upgrades', c.up4, 'downgrades', c.down4,
               'avgClvChange', round((c.avg_clv - ya.avg_clv)::numeric, 4),
               'churnQuarters', c.exp_n4,
               'churnVsExpected', case when c.exp_n4 > 0 then round(c.cve4::numeric, 1) end) end
         ) as base
  from w c
  left join w p  on p.seq  = c.seq - 1
  left join w ya on ya.seq = c.seq - 4
  left join plans pl on pl.qe = c.qe
  left join model md on md.qe = c.qe
  left join exv on exv.qe = c.qe
)
select seq, label, qe,
       base || jsonb_build_object('waterfall', wf, 'yearWaterfall', ywf) as data,
       wf_deviation, ywf_deviation, ce0_vs_prev, b_stayed, b_up, b_down
from j
with no data;

-- ---------------------------------------------------------------------------
-- 6. Publicatietabellen (nog niet gebruikt door de app)
-- ---------------------------------------------------------------------------
create table ce_public.quarters_v2 (
  seq    integer primary key check (seq >= 1),
  label  text    not null unique check (label ~ '^Q[1-4] [0-9]{4}$'),
  data   jsonb   not null check (jsonb_typeof(data) = 'object' and data ->> 'label' = label)
);
comment on table ce_public.quarters_v2 is
  'Kwartaalcijfers volgens het sBG-model (nog niet live). Alleen getallen, kwartaallabels en structuur.';

create table ce_public.publication_v2 (
  id                  smallint primary key default 1 check (id = 1),
  generated_at        timestamptz      not null,
  as_of               date             not null,
  load_id             bigint           not null,
  params_run_id       bigint           not null,
  discount_rate_year  double precision not null,
  horizon_months      integer          not null,
  grace_days          integer          not null,
  first_selectable    text             not null check (first_selectable ~ '^Q[1-4] [0-9]{4}$'),
  last_quarter        text             not null check (last_quarter ~ '^Q[1-4] [0-9]{4}$'),
  quarter_count       integer          not null check (quarter_count > 0),
  plans               jsonb            not null check (jsonb_typeof(plans) = 'array'),
  content_md5         text             not null
);
comment on table ce_public.publication_v2 is
  'Eén rij bij ce_public.quarters_v2: moment, herkomst, aannames en abonnementen (getallen).';

revoke all on ce_public.quarters_v2, ce_public.publication_v2 from public, anon, authenticated, service_role, ce_loader;
grant select on ce_public.quarters_v2, ce_public.publication_v2 to anon, ce_loader;
alter table ce_public.quarters_v2    enable row level security;
alter table ce_public.publication_v2 enable row level security;
create policy quarters_v2_public_read    on ce_public.quarters_v2    for select to anon using (true);
create policy publication_v2_public_read on ce_public.publication_v2 for select to anon using (true);
create policy quarters_v2_loader_read    on ce_public.quarters_v2    for select to ce_loader using (true);
create policy publication_v2_loader_read on ce_public.publication_v2 for select to ce_loader using (true);

-- ---------------------------------------------------------------------------
-- 7. Controles: elke rij is een fout
-- ---------------------------------------------------------------------------
create view ce_private.publication_checks_v2 with (security_invoker = true) as
with s as (select *, power(1 + discount_rate_year, -1.0 / 12) as d from ce_private.settings_v2),
j as (select * from ce_private.mv_bz_quarters_json),
qv as (select * from ce_private.mv_bz_quarters q, s where q.qs >= s.first_calc_quarter)
-- (1) Stroom per klantperiode sluit: actief begin + nieuw + reacquired − churn = actief eind,
--     en actief eind = actief begin van het volgende kwartaal.
select 'stroom'::text as check_name, q.label as item,
       format('begin %s + %s + %s - %s <> eind %s', q.active_begin, q.new, q.reacquired, q.churned, q.active_end) as detail
from qv q
where q.active_begin + q.new + q.reacquired - q.churned <> q.active_end
   or q.active_begin <> coalesce((select n.active_end from qv n where n.qe = q.qs - 1), q.active_begin)
union all
-- (2) Waterfalls sluiten (< 1 euro); stayed longer ≥ 0, upgrades ≥ 0, downgrades ≤ 0
select 'waterfall', j.label, format('kwartaal %s, jaar %s', j.wf_deviation, j.ywf_deviation)
from j where abs(coalesce(j.wf_deviation, 0)) >= 1 or abs(coalesce(j.ywf_deviation, 0)) >= 1
union all
select 'waterfall_tekens', j.label, format('stayed %s, up %s, down %s', j.b_stayed, j.b_up, j.b_down)
from j where j.b_stayed < -0.005 or j.b_up < -0.005 or j.b_down > 0.005
union all
-- (3) CE aan het begin (met p0) = CE van het vorige kwartaal (≤ 1 euro)
select 'ce_begin', j.label, format('afwijking %s', j.ce0_vs_prev)
from j where abs(j.ce0_vs_prev) > 1
union all
-- (4) Driververbanden: CE = actief × gem. CLV; gem. CLV = marge per toekomstige factuur ×
--     verwachte facturen; som per abonnement = totaal
select 'driver_a', j.label, 'CE <> actief x gemiddelde CLV'
from j where abs((j.data ->> 'activeEnd')::numeric * (j.data ->> 'avgClv')::numeric
                 - (j.data ->> 'customerEquity')::numeric) > 1
union all
select 'driver_c', j.label, 'gem. CLV <> marge per toekomstige factuur x verwachte facturen'
from j where abs(((j.data ->> 'marginPerFutureInvoice')::numeric * (j.data ->> 'expectedInvoices')::numeric
                  - (j.data ->> 'avgClv')::numeric) * (j.data ->> 'activeEnd')::numeric) > 1
union all
select 'abonnementen', j.label, 'som per abonnement <> totaal'
from j where abs((select sum((x ->> 'customerEquity')::numeric) from jsonb_array_elements(j.data -> 'plans') x)
                 - (j.data ->> 'customerEquity')::numeric) > 1
          or (select sum((x ->> 'activeEnd')::bigint) from jsonb_array_elements(j.data -> 'plans') x)
             <> (j.data ->> 'activeEnd')::bigint
union all
-- (5) Parameters: elk kwartaaleinde vanaf first_param_quarter heeft de verwachte segmenten,
--     uit een complete run op de laatste lading, allemaal geconvergeerd
select 'parameters', q.label, format('%s segmenten, verwacht %s', coalesce(p.cnt, 0), e.cnt)
from ce_private.v_bz_quarters q
cross join s
cross join (select count(distinct ce_private.bz_segment(grp, start_plan)) as cnt from ce_private.sbg_input
            where qe = (select max(qe) from ce_private.v_bz_quarters)) e
left join (select qe, count(*) as cnt from ce_private.v_bz_params group by qe) p on p.qe = q.qe
where q.qs >= s.first_param_quarter and coalesce(p.cnt, 0) <> e.cnt
union all
select 'parameters_run', null, 'laatste complete schatting hoort niet bij de laatste lading of is niet geconvergeerd'
where not exists (
  select 1 from ce_private.sbg_runs r
  where r.run_id = (select max(run_id) from ce_private.sbg_runs where status = 'complete')
    and r.load_id = (select max(load_id) from ce_private.loads where status = 'complete')
    and r.failed_fits = 0
    and r.segmentation = (select segmentation from ce_private.settings_v2)
    and r.returners = (select returners from ce_private.settings_v2))
union all
-- (6) DERL stijgt met de klantduur en blijft onder Σ δ^t
select 'derl', d.qe::text, format('segment %s, n %s', d.segment, d.n)
from (select qe, segment, n, derl, lag(derl) over (partition by qe, segment order by n) as prev
      from ce_private.mv_bz_derl) d
cross join s
where d.derl < d.prev - 1e-9 or d.derl >= (s.d * (1 - power(s.d, s.horizon_months)) / (1 - s.d))
union all
-- (7) Marge per abonnement positief
select 'marge', qe::text, format('abonnement %s: %s', plan_id, margin_eur)
from ce_private.mv_bz_plan_money where margin_eur is null or margin_eur <= 0
union all
-- (8) Vorm: verplichte getallen zijn getallen; de enige tekst is een kwartaallabel
select 'vorm_getal', j.label, key
from j cross join unnest(array['activeBegin', 'activeEnd', 'churnRate', 'customerEquity', 'avgClv',
                               'expectedInvoices', 'marginPerFutureInvoice', 'revenueEur']) as key
where jsonb_typeof(j.data -> key) is distinct from 'number'
union all
select 'vorm_tekst', j.label, v #>> '{}'
from j cross join lateral jsonb_path_query(j.data, 'strict $.**') as v
where jsonb_typeof(v) = 'string' and (v #>> '{}') !~ '^Q[1-4] [0-9]{4}$'
union all
-- (9) Volledig: alle kwartalen van first_dashboard_quarter t/m het laatste afgesloten kwartaal
select 'volledig', null, format('%s kwartalen, verwacht %s', (select count(*) from j), e.cnt)
from (select count(*) as cnt from ce_private.v_bz_quarters q, s where q.qs >= s.first_dashboard_quarter) e
where (select count(*) from j) <> e.cnt or e.cnt = 0
union all
-- (10) Een gepubliceerd kwartaal verandert niet meer (afgesloten kwartaal ongewijzigd)
select 'afgesloten_kwartaal', o.label, 'gepubliceerd kwartaal zou veranderen'
from ce_public.quarters_v2 o
join j on j.label = o.label
where j.data <> o.data
union all
-- (11) Bron: de laatste lading is complete
select 'bron', null, 'geen complete lading'
where not exists (select 1 from ce_private.loads where status = 'complete');

-- ---------------------------------------------------------------------------
-- 8. Verversen en publiceren (alles of niets)
-- ---------------------------------------------------------------------------
-- Stap 1 (vóór de schatting): de afgeleide views uit bz_*.
create function ce_private.refresh_v2_base()
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  set local statement_timeout = '10min';
  refresh materialized view ce_private.mv_bz_state;
  refresh materialized view ce_private.mv_bz_spells;
  refresh materialized view ce_private.mv_bz_month;
  refresh materialized view ce_private.mv_bz_plan_money;
  refresh materialized view ce_private.mv_bz_late;
  refresh materialized view ce_private.mv_bz_pairs;
  return 'ok';
end
$$;

-- Stap 2 (na de schatting): waarden, controles, publicatie naar ce_public.*_v2.
create function ce_private.publish_v2()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_fail    jsonb;
  v_n       integer;
  v_msg     text;
  v_detail  text;
begin
  begin
    set local statement_timeout = '10min';
    refresh materialized view ce_private.mv_bz_derl;
    refresh materialized view ce_private.mv_bz_wf_rows;
    refresh materialized view ce_private.mv_bz_quarters;
    refresh materialized view ce_private.mv_bz_plan_values;
    refresh materialized view ce_private.mv_bz_quarters_json;

    select jsonb_agg(to_jsonb(c)) into v_fail from ce_private.publication_checks_v2 c;
    if v_fail is not null then
      raise exception 'v2-controles mislukt (%)', jsonb_array_length(v_fail) using detail = v_fail::text;
    end if;

    delete from ce_public.quarters_v2;
    insert into ce_public.quarters_v2 (seq, label, data)
    select seq, label, data from ce_private.mv_bz_quarters_json order by seq;
    get diagnostics v_n = row_count;

    delete from ce_public.publication_v2;
    insert into ce_public.publication_v2
      (id, generated_at, as_of, load_id, params_run_id, discount_rate_year, horizon_months, grace_days,
       first_selectable, last_quarter, quarter_count, plans, content_md5)
    select 1, now(),
           (select as_of from ce_private.loads where status = 'complete' order by load_id desc limit 1),
           (select max(load_id) from ce_private.loads where status = 'complete'),
           (select max(run_id) from ce_private.sbg_runs where status = 'complete'),
           s.discount_rate_year, s.horizon_months, s.grace_days,
           (select label from ce_private.mv_bz_quarters_json
             where jsonb_typeof(data -> 'waterfall') = 'object' and jsonb_typeof(data -> 'yearWaterfall') = 'object'
             order by seq limit 1),
           (select label from ce_private.mv_bz_quarters_json order by seq desc limit 1),
           v_n,
           (select jsonb_agg(jsonb_build_object('planId', p.plan_id, 'sizeGrams', p.size_grams,
                     'priceExclVatCents', p.price_excl_vat_cents, 'costCents', c.cost_cents) order by p.size_grams)
              from ce_private.bz_plans p
              join ce_private.bz_product_costs c on c.plan_id = p.plan_id and c.valid_to is null
             where p.valid_to is null),
           (select md5(string_agg(seq || label || data::text, '|' order by seq)) from ce_public.quarters_v2)
    from ce_private.settings_v2 s;

    insert into ce_private.refresh_log (started_at, status, message)
    values (v_started, 'published', format('v2: %s kwartalen gepubliceerd in ce_public.quarters_v2', v_n));
    return 'published';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    insert into ce_private.refresh_log (started_at, status, message, details)
    values (v_started, 'failed', 'v2: ' || v_msg,
            case when v_detail like '[%' then v_detail::jsonb
                 when v_detail <> '' then to_jsonb(v_detail) end);
    return 'failed: ' || v_msg;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Rechten
-- ---------------------------------------------------------------------------
revoke all on ce_private.sbg_runs, ce_private.sbg_params, ce_private.validation_runs,
              ce_private.v_bz_params, ce_private.mv_bz_derl, ce_private.mv_bz_wf_rows,
              ce_private.mv_bz_quarters, ce_private.mv_bz_plan_values, ce_private.mv_bz_quarters_json,
              ce_private.publication_checks_v2
  from public, anon, authenticated, service_role;
revoke all on function ce_private.bz_segment(integer, integer),
                       ce_private.wf_json(text, text, double precision, double precision, bigint, bigint,
                                          double precision, double precision, double precision, double precision,
                                          double precision, double precision, double precision, double precision,
                                          double precision, double precision, bigint, bigint, bigint, bigint,
                                          bigint, bigint),
                       ce_private.refresh_v2_base(), ce_private.publish_v2()
  from public, anon, authenticated, service_role;

grant select, insert on ce_private.sbg_runs, ce_private.sbg_params, ce_private.validation_runs to ce_loader;
grant select on ce_private.v_bz_params, ce_private.mv_bz_derl, ce_private.mv_bz_wf_rows,
                ce_private.mv_bz_quarters, ce_private.mv_bz_plan_values, ce_private.mv_bz_quarters_json,
                ce_private.publication_checks_v2
  to ce_loader;
grant execute on function ce_private.bz_segment(integer, integer), ce_private.refresh_v2_base(),
                          ce_private.publish_v2()
  to ce_loader;

alter table ce_private.sbg_runs        enable row level security;
alter table ce_private.sbg_params      enable row level security;
alter table ce_private.validation_runs enable row level security;
create policy sbg_runs_loader_select   on ce_private.sbg_runs        for select to ce_loader using (true);
create policy sbg_runs_loader_insert   on ce_private.sbg_runs        for insert to ce_loader with check (true);
create policy sbg_params_loader_select on ce_private.sbg_params      for select to ce_loader using (true);
create policy sbg_params_loader_insert on ce_private.sbg_params      for insert to ce_loader with check (true);
create policy validation_loader_select on ce_private.validation_runs for select to ce_loader using (true);
create policy validation_loader_insert on ce_private.validation_runs for insert to ce_loader with check (true);
