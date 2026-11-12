-- Customer Equity · migratie 19
-- Flow-tegels New, Reacquired, Churn: een gewone YoY (dit kwartaal t.o.v. hetzelfde kwartaal een
-- jaar eerder, gebeurtenissen) in plaats van "Last 4 quarters" op het scherm.
--   * terug in de JSON: newVsYearAgo, reacquiredVsYearAgo, churnVsYearAgo ({abs, pct});
--   * blijven: …Last4Quarters, …Last4VsPrior4 en de controles flows_4kw en stroom_jaar;
--   * nieuwe controle flows_yoy: abs = verschil van de twee kwartaalwaarden, pct = abs ÷ waarde een
--     jaar eerder (1e-6), leeg zonder kwartaal een jaar eerder;
--   * controle afgesloten_kwartaal: nieuwe velden op het hoogste niveau mogen erbij, zodat
--     quarters_v2 niet opnieuw leeg hoeft; elk gepubliceerd veld moet met dezelfde waarde blijven.
-- Migratie 1–18 blijven ongewijzigd.

drop view if exists ce_private.publication_checks_v2;
drop materialized view if exists ce_private.mv_bz_quarters_json;

create materialized view ce_private.mv_bz_quarters_json as
with s as (select * from ce_private.settings_v2),
-- Sommen over de laatste vier kwartalen en de vier daarvoor, over alle rekenkwartalen
-- (ook vóór het dashboard), zodat ook het eerste kiesbare kwartaal een vergelijking heeft.
l as (
  select q.qe,
         case when count(*) over l4 = 4 then (sum(q.new) over l4)::bigint end        as new_l4,
         case when count(*) over l4 = 4 then (sum(q.reacquired) over l4)::bigint end as reacq_l4,
         case when count(*) over l4 = 4 then (sum(q.churned) over l4)::bigint end    as churn_l4,
         -- mix en value bestaan pas vanaf het eerste kwartaal met parameters: alle vier nodig
         case when count(q.mix) over l4 = 4 then sum(q.mix) over l4 end              as mix_l4,
         case when count(q.existing) over l4 = 4 then sum(q.existing) over l4 end    as existing_l4
  from ce_private.mv_bz_quarters q
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
         lp.new_p4, lp.reacq_p4, lp.churn_p4
  from ce_private.mv_bz_quarters q
  join lp on lp.qe = q.qe, s
  where q.qs >= s.first_dashboard_quarter
),
w as (
  select d.*,
         (sum(new) over l4)::bigint as new4, (sum(reacquired) over l4)::bigint as reacq4,
         (sum(churned) over l4)::bigint as churn4,
         sum(b_new) over l4 as y_new, sum(b_reacq) over l4 as y_reacq, sum(b_churn) over l4 as y_churn,
         sum(b_mix) over l4 as y_mix, sum(b_existing) over l4 as y_existing,
         sum(mix) over l4 as mix4, sum(existing) over l4 as existing4
  from d
  window l4 as (order by seq rows between 3 preceding and current row)
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
           ce_private.wf5_json(p.label, c.label, c.ce0, c.customer_equity, c.active_begin, c.active_end,
                               c.avg0, c.avg1, c.b_new, c.b_reacq, c.b_churn, c.b_mix, c.b_existing,
                               c.mix, c.existing, c.new, c.reacquired, c.churned, c.staying) end as wf,
         case when ya.seq is not null then
           ce_private.wf5_json(ya.label, c.label, ya.customer_equity, c.customer_equity, ya.active_end,
                               c.active_end, ya.avg1, c.avg1, c.y_new, c.y_reacq, c.y_churn, c.y_mix,
                               c.y_existing, c.mix4, c.existing4, c.new4, c.reacq4, c.churn4, null) end as ywf,
         -- voor de controles (niet gepubliceerd)
         case when ya.seq is not null then (c.active_end - ya.active_end) - (c.new4 + c.reacq4 - c.churn4) end
                                                                                       as yflow_deviation,
         c.ce0 - coalesce(p.customer_equity, c.ce0)                                   as ce0_vs_prev,
         (c.avg1 - c.avg0) - (c.mix + c.existing)                                     as avg_deviation,
         c.b_new + c.b_reacq + c.b_churn + c.b_mix + c.b_existing - (c.customer_equity - c.ce0) as wf_deviation,
         c.y_new + c.y_reacq + c.y_churn + c.y_mix + c.y_existing
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
-- (2) Δ gemiddelde CLV = Customer mix + Existing customer value (per kwartaal en per jaar)
select 'mix_existing', j.label, format('kwartaal %s, jaar %s', j.avg_deviation, j.yavg_deviation)
from j where abs(j.avg_deviation) > 1e-9 or abs(coalesce(j.yavg_deviation, 0)) > 1e-9
union all
-- (3) De vijf balken tellen op tot CE1 − CE0 (< 1 euro), per kwartaal en per jaar
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
-- (4) Jaar = som van de vier kwartalen (balken op 5 cent na afronding, aantallen exact)
select 'jaar_som', j.label, b.key
from j
cross join lateral (values ('newCustomers'), ('reacquiredCustomers'), ('churn'),
                           ('customerMix'), ('existingCustomerValue')) as b(key)
where j.data -> 'yearWaterfall' <> 'null'::jsonb
  and abs((j.data #>> array['yearWaterfall', 'parts', b.key])::numeric
          - (select sum((x.data #>> array['waterfall', 'parts', b.key])::numeric)
               from j x where x.seq between j.seq - 3 and j.seq)) > 0.05
union all
select 'jaar_som_aantallen', j.label, b.key
from j
cross join lateral (values ('newCustomers'), ('reacquiredCustomers'), ('churn')) as b(key)
where j.data -> 'yearWaterfall' <> 'null'::jsonb
  and (j.data #>> array['yearWaterfall', 'counts', b.key])::bigint
      <> (select sum((x.data #>> array['waterfall', 'counts', b.key])::bigint)
            from j x where x.seq between j.seq - 3 and j.seq)
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

revoke all on ce_private.mv_bz_quarters_json, ce_private.publication_checks_v2
  from public, anon, authenticated, service_role;
grant select on ce_private.mv_bz_quarters_json, ce_private.publication_checks_v2 to ce_loader;
