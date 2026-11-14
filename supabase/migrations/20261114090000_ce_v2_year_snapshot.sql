-- Customer Equity · migratie 22
-- Jaarwaterfall foto tegen foto (besluit 14 nov 2026): van het eind van hetzelfde kwartaal vorig jaar
-- naar het eind van het gekozen kwartaal, elke klant tegen zijn eigen CLV. Niet meer de som van vier
-- kwartalen. De kwartaalwaterfall blijft zoals in migratie 21.
--   * New       = actief nu, niet een jaar eerder, eerste factuur ooit daarna; CLV nu;
--   * Reacquired = actief nu, niet een jaar eerder, al klant vóór dat moment; CLV nu;
--   * Churn     = actief een jaar eerder, nu niet; CLV een jaar eerder;
--   * Existing  = actief op beide momenten; CLV nu − CLV een jaar eerder.
-- Aantallen in yearWaterfall.counts zijn netto (inclusief stayingCustomers), niet de gebeurtenissen.
-- Controles: waterfall (vier balken = CE eind − CE begin, < €1) geldt nu voor de foto-jaarwaterfall;
-- jaar_som en jaar_som_aantallen vervallen (het jaar is geen som van kwartalen meer); nieuw: jaar_netto
-- (netto aantallen sluiten). publish_v2() ververst ook mv_bz_year_rows.
--
-- Eenmalig: ce_public.quarters_v2 en publication_v2 worden hier leeggemaakt, omdat de bedragen van de
-- jaarwaterfall van gepubliceerde kwartalen veranderen (definitiewijziging, niet de data); de controle
-- "afgesloten kwartaal verandert niet" zou de publicatie anders tegenhouden. Besloten door Lotte,
-- 14 nov 2026. ce_public.quarters (live) blijft ongemoeid. Migratie 1–21 blijven ongewijzigd.

drop view if exists ce_private.publication_checks_v2;
drop materialized view if exists ce_private.mv_bz_quarters_json, ce_private.mv_bz_year_rows;

-- ---------------------------------------------------------------------------
-- 1. Jaarvergelijking foto tegen foto: per kwartaaleinde qe en het kwartaaleinde een jaar eerder (qe0),
--    elke klant met zijn eigen CLV op beide momenten (zelfde CLV als in customer equity: vgrid ×
--    respijtfactor bij wie niet doorbetaald is). Per klant (niet per klantperiode):
--      S = actief op beide momenten; L = alleen op qe0; R = alleen op qe en al klant vóór qe0;
--      N = alleen op qe, eerste factuur ooit na qe0. Wie tussendoor kwam en ging komt niet voor.
-- ---------------------------------------------------------------------------
create materialized view ce_private.mv_bz_year_rows as
with q as (select qe, lag(qe, 4) over (order by qe) as qe0 from ce_private.v_bz_quarters),
firsts as (select customer_id, min(known_start) as first_known from ce_private.mv_bz_spells group by customer_id),
v as (
  select x.qe, x.customer_id,
         (case when x.paid_through then 1 else g.g end) * vg.val as clv
  from ce_private.mv_bz_state x
  join ce_private.mv_bz_late g on g.qe = x.qe
  join ce_private.mv_bz_vgrid vg on vg.qe = x.qe and vg.n = x.n and vg.plan_id = x.plan_id
   and vg.segment = ce_private.bz_segment(x."returning"::integer + 1, x.start_plan::integer)
),
u as (
  select q.qe, q.qe0, v.customer_id, null::double precision as clv0, v.clv as clv1
  from q join v on v.qe = q.qe where q.qe0 is not null
  union all
  select q.qe, q.qe0, v.customer_id, v.clv, null
  from q join v on v.qe = q.qe0
),
c as (
  select qe, qe0, customer_id, sum(clv0) as clv0, sum(clv1) as clv1
  from u group by qe, qe0, customer_id
)
select c.qe,
       case when c.clv0 is not null and c.clv1 is not null then 'S'
            when c.clv0 is not null then 'L'
            when f.first_known <= c.qe0 then 'R' else 'N' end as flow,
       count(*)::bigint as customers,
       coalesce(sum(c.clv0), 0) as v0,
       coalesce(sum(c.clv1), 0) as v1
from c left join firsts f using (customer_id)
group by 1, 2
with no data;
comment on materialized view ce_private.mv_bz_year_rows is
  'Jaarwaterfall foto tegen foto (migratie 22): per kwartaaleinde en groep (S, L, R, N) het aantal klanten '
  'en de som van hun eigen CLV een jaar eerder (v0) en nu (v1).';

create materialized view ce_private.mv_bz_quarters_json as
with s as (select * from ce_private.settings_v2),
-- Sommen over de laatste vier kwartalen en de vier daarvoor, over alle rekenkwartalen
-- (ook vóór het dashboard), zodat ook het eerste kiesbare kwartaal een vergelijking heeft.
l as (
  select q.qe, q.mix_in, q.mix_out,
         case when count(*) over l4 = 4 then (sum(q.new) over l4)::bigint end        as new_l4,
         case when count(*) over l4 = 4 then (sum(q.reacquired) over l4)::bigint end as reacq_l4,
         case when count(*) over l4 = 4 then (sum(q.churned) over l4)::bigint end    as churn_l4,
         -- mix en value bestaan pas vanaf het eerste kwartaal met parameters: alle vier nodig
         case when count(q.mix) over l4 = 4 then sum(q.mix) over l4 end              as mix_l4,
         case when count(q.existing) over l4 = 4 then sum(q.existing) over l4 end    as existing_l4,
         case when count(q.mix_in) over l4 = 4 then sum(q.mix_in) over l4 end        as mix_in_l4,
         case when count(q.mix_out) over l4 = 4 then sum(q.mix_out) over l4 end      as mix_out_l4
  -- Mix effect in twee delen (migratie 20), per kwartaal, met S = blijvers (actief aan begin én eind):
  --   nieuwkomers = N_in/N_eind × (CLV_in − CLV_S,begin), vertrekkers = N_uit/N_begin × (CLV_S,begin − CLV_uit).
  --   Samen exact het mix effect: (avg1 − avg0) − (N_S/N_eind)(CLV_S,eind − CLV_S,begin).
  from (select q.*,
               (q.customer_equity - q.stay1 - (q.active_end - q.staying) * q.stay0 / q.staying) / q.active_end
                 as mix_in,
               ((q.active_begin - q.staying) * q.stay0 / q.staying - (q.ce0 - q.stay0)) / q.active_begin
                 as mix_out
        from ce_private.mv_bz_quarters q) q
  window l4 as (order by q.qe rows between 3 preceding and current row)
),
lp as (
  select l.*, lag(new_l4, 4) over o as new_p4, lag(reacq_l4, 4) over o as reacq_p4,
         lag(churn_l4, 4) over o as churn_p4
  from l window o as (order by qe)
),
d as (
  select row_number() over (order by q.qe)::integer as seq, q.*,
         q.re1 / q.active_end   as expected_invoices,
         q.customer_equity / q.re1 as margin_future,
         lp.new_l4, lp.reacq_l4, lp.churn_l4, lp.mix_l4, lp.existing_l4,
         lp.mix_in, lp.mix_out, lp.mix_in_l4, lp.mix_out_l4,
         lp.new_p4, lp.reacq_p4, lp.churn_p4
  from ce_private.mv_bz_quarters q
  join lp on lp.qe = q.qe, s
  where q.qs >= s.first_dashboard_quarter
),
w as (
  select d.*,
         (sum(new) over l4)::bigint as new4, (sum(reacquired) over l4)::bigint as reacq4,
         (sum(churned) over l4)::bigint as churn4,
         sum(mix) over l4 as mix4, sum(existing) over l4 as existing4
  from d
  window l4 as (order by seq rows between 3 preceding and current row)
),
-- Jaarwaterfall foto tegen foto (migratie 22): uit mv_bz_year_rows, per kwartaaleinde.
yr as (
  select qe,
         sum(v1) filter (where flow = 'N')        as y_new,
         sum(v1) filter (where flow = 'R')        as y_reacq,
         - sum(v0) filter (where flow = 'L')      as y_churn,
         sum(v1 - v0) filter (where flow = 'S')   as y_existing,
         sum(customers) filter (where flow = 'N') as y_n_new,
         sum(customers) filter (where flow = 'R') as y_n_reacq,
         sum(customers) filter (where flow = 'L') as y_n_churn,
         sum(customers) filter (where flow = 'S') as y_n_stay
  from ce_private.mv_bz_year_rows group by qe
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
           'value', round(vg.val::numeric, 4)) as example
  from ex
  join (select distinct plan_id, size_grams from ce_private.bz_plans) sz using (plan_id)
  join ce_private.mv_bz_plan_money m on m.qe = ex.qe and m.plan_id = ex.plan_id
  join ce_private.mv_bz_derl dl on dl.qe = ex.qe and dl.n = 1
   and dl.segment = ce_private.bz_segment(1, ex.plan_id)
  join ce_private.mv_bz_vgrid vg on vg.qe = ex.qe and vg.n = 1 and vg.plan_id = ex.plan_id
   and vg.segment = ce_private.bz_segment(1, ex.plan_id)
),
j as (
  select c.seq, c.label, c.qe,
         case when p.seq is not null then
           ce_private.wf4_json(p.label, c.label, c.ce0, c.customer_equity, c.active_begin, c.active_end,
                               c.avg0, c.avg1, c.b_new, c.b_reacq, c.b_churn, c.b_existing,
                               c.new, c.reacquired, c.churned, c.staying) end as wf,
         case when ya.seq is not null then
           ce_private.wf4_json(ya.label, c.label, ya.customer_equity, c.customer_equity, ya.active_end,
                               c.active_end, ya.avg1, c.avg1, coalesce(yr.y_new, 0), coalesce(yr.y_reacq, 0),
                               coalesce(yr.y_churn, 0), coalesce(yr.y_existing, 0), coalesce(yr.y_n_new, 0)::bigint,
                               coalesce(yr.y_n_reacq, 0)::bigint, coalesce(yr.y_n_churn, 0)::bigint,
                               coalesce(yr.y_n_stay, 0)::bigint) end as ywf,
         -- voor de controles (niet gepubliceerd)
         case when ya.seq is not null then (c.active_end - ya.active_end) - (c.new4 + c.reacq4 - c.churn4) end
                                                                                       as yflow_deviation,
         c.ce0 - coalesce(p.customer_equity, c.ce0)                                   as ce0_vs_prev,
         (c.avg1 - c.avg0) - (c.mix + c.existing)                                     as avg_deviation,
         c.b_new + c.b_reacq + c.b_churn + c.b_existing - (c.customer_equity - c.ce0) as wf_deviation,
         coalesce(yr.y_new, 0) + coalesce(yr.y_reacq, 0) + coalesce(yr.y_churn, 0) + coalesce(yr.y_existing, 0)
           - (c.customer_equity - ya.customer_equity)                                as ywf_deviation,
         case when ya.seq is not null then (c.avg1 - ya.avg1) - (c.mix4 + c.existing4) end as yavg_deviation,
         jsonb_build_object(
           'label', c.label,
           'activeBegin', c.active_begin, 'activeEnd', c.active_end,
           'newCustomers', c.new, 'reacquiredCustomers', c.reacquired,
           'acquiredCustomers', c.new + c.reacquired, 'churn', c.churned,
           'churnRate', round(c.churn_rate::numeric, 6),
           'revenueEur', round(c.revenue_eur::numeric, 2),
           'customerEquity', round(c.customer_equity::numeric, 2),
           'avgClv', c.avg1,
           'avgClvChange', c.avg1 - c.avg0,
           'customerMix', c.mix,
           'existingCustomerValue', c.existing,
           'expectedInvoices', c.expected_invoices,
           'marginPerFutureInvoice', c.margin_future,
           'lateRenewalFactor', round(c.g::numeric, 6),
           'model', md.model, 'clvExample', exv.example)
         || jsonb_build_object(
           'equityVsPrevQuarter', ce_private.change_json(c.customer_equity, p.customer_equity),
           'equityVsYearAgo', ce_private.change_json(c.customer_equity, ya.customer_equity),
           'activeVsPrevQuarter', ce_private.change_json(c.active_end, p.active_end),
           'activeVsYearAgo', ce_private.change_json(c.active_end, ya.active_end),
           'avgClvVsPrevQuarter', ce_private.change_json(c.avg1, p.avg1),
           'avgClvVsYearAgo', ce_private.change_json(c.avg1, ya.avg1),
           -- Flows: vorig kwartaal, en de laatste vier kwartalen tegenover de vier daarvoor.
           'newVsPrevQuarter', ce_private.change_json(c.new, p.new),
           'reacquiredVsPrevQuarter', ce_private.change_json(c.reacquired, p.reacquired),
           'churnVsPrevQuarter', ce_private.change_json(c.churned, p.churned),
           -- YoY van de flows: dit kwartaal t.o.v. hetzelfde kwartaal een jaar eerder (migratie 19).
           'newVsYearAgo', ce_private.change_json(c.new, ya.new),
           'reacquiredVsYearAgo', ce_private.change_json(c.reacquired, ya.reacquired),
           'churnVsYearAgo', ce_private.change_json(c.churned, ya.churned),
           'newLast4Quarters', c.new_l4,
           'reacquiredLast4Quarters', c.reacq_l4,
           'churnLast4Quarters', c.churn_l4,
           'newLast4VsPrior4', ce_private.change_json(c.new_l4, c.new_p4),
           'reacquiredLast4VsPrior4', ce_private.change_json(c.reacq_l4, c.reacq_p4),
           'churnLast4VsPrior4', ce_private.change_json(c.churn_l4, c.churn_p4),
           -- Mix en value effect: som over de laatste vier kwartalen (euro per klant, met teken).
           'customerMixLast4Quarters', round(c.mix_l4::numeric, 4),
           'existingCustomerValueLast4Quarters', round(c.existing_l4::numeric, 4),
           -- Mix effect in twee delen: nieuwkomers en vertrekkers t.o.v. de blijvers (migratie 20).
           'customerMixNewcomers', c.mix_in,
           'customerMixLeavers', c.mix_out,
           'customerMixNewcomersLast4Quarters', round(c.mix_in_l4::numeric, 4),
           'customerMixLeaversLast4Quarters', round(c.mix_out_l4::numeric, 4),
           'churnRateVsPrevQuarter', ce_private.rate_change(c.churn_rate, p.churn_rate),
           'churnRateVsYearAgo', ce_private.rate_change(c.churn_rate, ya.churn_rate),
           'yearSummary', case when ya.seq is not null then jsonb_build_object(
               'acquiredCustomers', c.new4 + c.reacq4, 'newCustomers', c.new4,
               'reacquiredCustomers', c.reacq4, 'churn', c.churn4,
               'avgClvChange', round((c.avg1 - ya.avg1)::numeric, 4),
               'customerMix', round(c.mix4::numeric, 4),
               'existingCustomerValue', round(c.existing4::numeric, 4)) end
         ) as base
  from w c
  left join w p  on p.seq  = c.seq - 1
  left join w ya on ya.seq = c.seq - 4
  left join model md on md.qe = c.qe
  left join exv on exv.qe = c.qe
  left join yr on yr.qe = c.qe
)
select seq, label, qe,
       base || jsonb_build_object('waterfall', wf, 'yearWaterfall', ywf) as data,
       wf_deviation, ywf_deviation, ce0_vs_prev, avg_deviation, yavg_deviation, yflow_deviation
from j
with no data;

create view ce_private.publication_checks_v2 with (security_invoker = true) as
with s as (select *, power(1 + discount_rate_year, -1.0 / 12) as d from ce_private.settings_v2),
j as (select * from ce_private.mv_bz_quarters_json),
qv as (select * from ce_private.mv_bz_quarters q, s where q.qs >= s.first_calc_quarter)
-- (1) Klantenstroom sluit: eind = begin + new + reacquired − churn (gebeurtenissen), begin = vorig eind
select 'stroom'::text as check_name, q.label as item,
       format('begin %s + %s + %s - %s <> eind %s', q.active_begin, q.new, q.reacquired, q.churned, q.active_end) as detail
from qv q
where q.active_begin + q.new + q.reacquired - q.churned <> q.active_end
   or q.active_begin <> coalesce((select n.active_end from qv n where n.qe = q.qs - 1), q.active_begin)
union all
-- (1b) Jaar: actief nu − actief een jaar eerder = som van de flows over vier kwartalen
select 'stroom_jaar', j.label, format('afwijking %s', j.yflow_deviation)
from j where coalesce(j.yflow_deviation, 0) <> 0
union all
-- (1c) Flows over vier kwartalen in de JSON = som van de vier kwartalen
select 'flows_4kw', j.label, b.key
from j
cross join lateral (values ('newCustomers', 'newLast4Quarters'), ('reacquiredCustomers', 'reacquiredLast4Quarters'),
                           ('churn', 'churnLast4Quarters')) as b(key, key4)
where j.data -> 'yearWaterfall' <> 'null'::jsonb
  and (j.data ->> b.key4)::bigint
      <> (select sum((x.data ->> b.key)::bigint) from j x where x.seq between j.seq - 3 and j.seq)
union all
-- (1d) YoY van de flows = verschil van de twee kwartaalwaarden (gebeurtenissen), en leeg zonder
--      kwartaal een jaar eerder
select 'flows_yoy', j.label, b.key
from j
cross join lateral (values ('newCustomers', 'newVsYearAgo'), ('reacquiredCustomers', 'reacquiredVsYearAgo'),
                           ('churn', 'churnVsYearAgo')) as b(key, yoy)
left join j ya on ya.seq = j.seq - 4
where case when ya.seq is null then jsonb_typeof(j.data -> b.yoy) is distinct from 'null'
           else (j.data #>> array[b.yoy, 'abs'])::numeric is distinct from
                (j.data ->> b.key)::numeric - (ya.data ->> b.key)::numeric
             or abs((j.data #>> array[b.yoy, 'pct'])::numeric
                    - ((j.data ->> b.key)::numeric - (ya.data ->> b.key)::numeric) / (ya.data ->> b.key)::numeric) > 1e-6
      end
union all
-- (1e) Mix effect = nieuwkomers + vertrekkers (≤ 1 cent), per kwartaal en over vier kwartalen
select 'mix_delen', j.label,
       format('kwartaal %s + %s ≠ %s; vier kwartalen %s + %s ≠ %s',
              j.data ->> 'customerMixNewcomers', j.data ->> 'customerMixLeavers', j.data ->> 'customerMix',
              j.data ->> 'customerMixNewcomersLast4Quarters', j.data ->> 'customerMixLeaversLast4Quarters',
              j.data ->> 'customerMixLast4Quarters')
from j
where jsonb_typeof(j.data -> 'customerMixNewcomers') is distinct from 'number'
   or jsonb_typeof(j.data -> 'customerMixLeavers') is distinct from 'number'
   or abs((j.data ->> 'customerMixNewcomers')::numeric + (j.data ->> 'customerMixLeavers')::numeric
          - (j.data ->> 'customerMix')::numeric) > 0.01
   or (jsonb_typeof(j.data -> 'customerMixNewcomersLast4Quarters') = 'number')
      is distinct from (jsonb_typeof(j.data -> 'customerMixLast4Quarters') = 'number')
   or abs(coalesce((j.data ->> 'customerMixNewcomersLast4Quarters')::numeric
                   + (j.data ->> 'customerMixLeaversLast4Quarters')::numeric
                   - (j.data ->> 'customerMixLast4Quarters')::numeric, 0)) > 0.01
union all
-- (2) Δ gemiddelde CLV = Customer mix + Existing customer value (per kwartaal en per jaar)
select 'mix_existing', j.label, format('kwartaal %s, jaar %s', j.avg_deviation, j.yavg_deviation)
from j where abs(j.avg_deviation) > 1e-9 or abs(coalesce(j.yavg_deviation, 0)) > 1e-9
union all
-- (3) De vier balken tellen op tot CE eind − CE begin (< 1 euro): kwartaal (begin → eind kwartaal) en
--     jaar (eind zelfde kwartaal vorig jaar → eind gekozen kwartaal, foto tegen foto)
select 'waterfall', j.label, format('kwartaal %s, jaar %s', j.wf_deviation, j.ywf_deviation)
from j where abs(coalesce(j.wf_deviation, 0)) >= 1 or abs(coalesce(j.ywf_deviation, 0)) >= 1
union all
-- (3b) Hero-kaart: QoQ-verschil (CE nu − CE vorig kwartaal, zoals gepubliceerd) = som van de
--      vijf balken van de kwartaalwaterfall (≤ 1 euro). Het YoY-verschil zit al in (3).
select 'equity_qoq', j.label,
       format('QoQ %s, som balken %s', j.data #>> '{equityVsPrevQuarter,abs}',
              (select sum(v::numeric) from jsonb_each_text(j.data #> '{waterfall,parts}') t(k, v)))
from j
where jsonb_typeof(j.data -> 'equityVsPrevQuarter') = 'object'
  and (jsonb_typeof(j.data -> 'waterfall') is distinct from 'object'
       or abs((j.data #>> '{equityVsPrevQuarter,abs}')::numeric
              - (select sum(v::numeric) from jsonb_each_text(j.data #> '{waterfall,parts}') t(k, v))) > 1)
union all
-- (4) Jaarwaterfall foto tegen foto (migratie 22; vervangt jaar_som en jaar_som_aantallen):
--     netto aantallen sluiten: actief een jaar eerder + new + reacquired − churn = actief nu,
--     en blijvers + churn = actief een jaar eerder.
select 'jaar_netto', j.label,
       format('%s + %s + %s − %s ≠ %s', j.data #>> '{yearWaterfall,customersBegin}',
              j.data #>> '{yearWaterfall,counts,newCustomers}', j.data #>> '{yearWaterfall,counts,reacquiredCustomers}',
              j.data #>> '{yearWaterfall,counts,churn}', j.data #>> '{yearWaterfall,customersEnd}')
from j
where j.data -> 'yearWaterfall' <> 'null'::jsonb
  and ((j.data #>> '{yearWaterfall,customersBegin}')::bigint + (j.data #>> '{yearWaterfall,counts,newCustomers}')::bigint
       + (j.data #>> '{yearWaterfall,counts,reacquiredCustomers}')::bigint - (j.data #>> '{yearWaterfall,counts,churn}')::bigint
       <> (j.data #>> '{yearWaterfall,customersEnd}')::bigint
    or (j.data #>> '{yearWaterfall,counts,stayingCustomers}')::bigint + (j.data #>> '{yearWaterfall,counts,churn}')::bigint
       <> (j.data #>> '{yearWaterfall,customersBegin}')::bigint)
union all
-- (5) CE aan het begin (met p0) = CE van het vorige kwartaal (≤ 1 euro)
select 'ce_begin', j.label, format('afwijking %s', j.ce0_vs_prev)
from j where abs(j.ce0_vs_prev) > 1
union all
-- (6) CE = actief × gemiddelde CLV; gemiddelde CLV = verwachte facturen × marge per toekomstige factuur
select 'driver_a', j.label, 'CE <> actief x gemiddelde CLV'
from j where abs((j.data ->> 'activeEnd')::numeric * (j.data ->> 'avgClv')::numeric
                 - (j.data ->> 'customerEquity')::numeric) > 1
union all
select 'driver_c', j.label, 'gem. CLV <> verwachte facturen x marge per toekomstige factuur'
from j where abs(((j.data ->> 'marginPerFutureInvoice')::numeric * (j.data ->> 'expectedInvoices')::numeric
                  - (j.data ->> 'avgClv')::numeric) * (j.data ->> 'activeEnd')::numeric) > 1
union all
-- (7) Parameters: verwachte segmenten per kwartaaleinde, uit een complete run op de laatste lading
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
-- (8) DERL stijgt met de klantduur en blijft onder Σ δ^t
select 'derl', d.qe::text, format('segment %s, n %s', d.segment, d.n)
from (select qe, segment, n, derl, lag(derl) over (partition by qe, segment order by n) as prev
      from ce_private.mv_bz_derl) d
cross join s
where d.derl < d.prev - 1e-9 or d.derl >= (s.d * (1 - power(s.d, s.horizon_months)) / (1 - s.d))
union all
-- (9) Marge per abonnement positief, voor elk abonnement op elk kwartaaleinde
select 'marge', q.label, format('abonnement %s: %s', p.plan_id, m.margin_eur)
from ce_private.v_bz_quarters q
cross join (select distinct plan_id from ce_private.bz_plans) p
left join ce_private.mv_bz_plan_money m on m.qe = q.qe and m.plan_id = p.plan_id
where m.margin_eur is null or m.margin_eur <= 0
union all
-- (10) Vorm: verplichte getallen; de enige tekst is een kwartaallabel
select 'vorm_getal', j.label, key
from j cross join unnest(array['activeBegin', 'activeEnd', 'churnRate', 'customerEquity', 'avgClv',
                               'avgClvChange', 'customerMix', 'existingCustomerValue',
                               'expectedInvoices', 'marginPerFutureInvoice', 'revenueEur']) as key
where jsonb_typeof(j.data -> key) is distinct from 'number'
union all
select 'vorm_tekst', j.label, v #>> '{}'
from j cross join lateral jsonb_path_query(j.data, 'strict $.**') as v
where jsonb_typeof(v) = 'string' and (v #>> '{}') !~ '^Q[1-4] [0-9]{4}$'
union all
-- (11) Volledig
select 'volledig', null, format('%s kwartalen, verwacht %s', (select count(*) from j), e.cnt)
from (select count(*) as cnt from ce_private.v_bz_quarters q, s where q.qs >= s.first_dashboard_quarter) e
where (select count(*) from j) <> e.cnt or e.cnt = 0
union all
-- (12) Een gepubliceerd kwartaal verandert niet meer (tolerantie: één cent, 1e-9 relatief).
--      Nieuwe velden op het hoogste niveau mogen erbij (migratie 19); elk gepubliceerd veld moet
--      blijven bestaan met dezelfde waarde.
select 'afgesloten_kwartaal', o.label, 'gepubliceerd kwartaal zou veranderen'
from ce_public.quarters_v2 o
join j on j.label = o.label
where not ce_private.jsonb_close(
        j.data - array(select k from jsonb_object_keys(j.data) k where not o.data ? k), o.data)
union all
-- (13) Bron
select 'bron', null, 'geen complete lading'
where not exists (select 1 from ce_private.loads where status = 'complete');


-- ---------------------------------------------------------------------------
-- publish_v2: als migratie 16, met mv_bz_year_rows in de verversing
-- ---------------------------------------------------------------------------
create or replace function ce_private.publish_v2()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_fail    jsonb;
  v_n       integer;
  v_msg     text;
  v_detail  text;
  v_factor  double precision;
begin
  begin
    set local statement_timeout = '10min';
    set local max_parallel_workers_per_gather = 0;  -- vaste volgorde van optellen
    refresh materialized view ce_private.mv_bz_plan_money;
    refresh materialized view ce_private.mv_bz_margin_path;
    refresh materialized view ce_private.mv_bz_derl;
    refresh materialized view ce_private.mv_bz_vgrid;
    refresh materialized view ce_private.mv_bz_wf_rows;
    refresh materialized view ce_private.mv_bz_quarters;
    refresh materialized view ce_private.mv_bz_year_rows;
    refresh materialized view ce_private.mv_bz_quarters_json;

    select jsonb_agg(to_jsonb(c)) into v_fail from ce_private.publication_checks_v2 c;
    if v_fail is not null then
      raise exception 'v2-controles mislukt (%)', jsonb_array_length(v_fail) using detail = v_fail::text;
    end if;

    -- Wat €1 aan het eind van de horizon vandaag waard is; leeg of buiten (0, 1] = niet publiceren.
    select power(1 + s.discount_rate_year, -s.horizon_months / 12.0) into v_factor from ce_private.settings_v2 s;
    if v_factor is null or not (v_factor > 0 and v_factor <= 1) then
      raise exception 'horizon_discount_factor ontbreekt of is ongeldig (%)', v_factor;
    end if;

    delete from ce_public.quarters_v2;
    insert into ce_public.quarters_v2 (seq, label, data)
    select seq, label, data from ce_private.mv_bz_quarters_json order by seq;
    get diagnostics v_n = row_count;

    delete from ce_public.publication_v2;
    insert into ce_public.publication_v2
      (id, generated_at, as_of, load_id, params_run_id, discount_rate_year, horizon_months, grace_days,
       first_selectable, last_quarter, quarter_count, plans, content_md5, horizon_discount_factor)
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
           (select md5(string_agg(seq || label || data::text, '|' order by seq)) from ce_public.quarters_v2),
           v_factor
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

revoke all on ce_private.mv_bz_year_rows, ce_private.mv_bz_quarters_json, ce_private.publication_checks_v2
  from public, anon, authenticated, service_role;
revoke all on function ce_private.publish_v2() from public, anon, authenticated, service_role;
grant select on ce_private.mv_bz_year_rows, ce_private.mv_bz_quarters_json, ce_private.publication_checks_v2
  to ce_loader;
grant execute on function ce_private.publish_v2() to ce_loader;

-- ---------------------------------------------------------------------------
-- Eenmalig leegmaken (zie boven); publish_v2() vult beide tabellen opnieuw.
-- ---------------------------------------------------------------------------
delete from ce_public.quarters_v2;
delete from ce_public.publication_v2;
