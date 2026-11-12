-- Customer Equity · migratie 18
-- Hero-kaart customer equity: QoQ en YoY sluiten aan op de waterfalls.
--   * YoY: al gecontroleerd in (3) 'waterfall' (som jaarbalken = CE nu − CE een jaar eerder, < 1 euro).
--   * QoQ: nieuw, 'equity_qoq': het gepubliceerde equityVsPrevQuarter.abs (CE nu − CE vorig kwartaal)
--     = som van de vijf balken van de kwartaalwaterfall, afwijking ≤ 1 euro; anders geen publicatie.
--     Tot nu toe alleen indirect: (3) meet tegen CE aan het begin (ce0) en (5) ce0 tegen vorig kwartaal.
-- Geen nieuwe velden; alleen de controleview (zelfde kolommen). Migratie 17 blijft ongewijzigd.

create or replace view ce_private.publication_checks_v2 with (security_invoker = true) as
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
-- (12) Een gepubliceerd kwartaal verandert niet meer (tolerantie: één cent, 1e-9 relatief)
select 'afgesloten_kwartaal', o.label, 'gepubliceerd kwartaal zou veranderen'
from ce_public.quarters_v2 o
join j on j.label = o.label
where not ce_private.jsonb_close(j.data, o.data)
union all
-- (13) Bron
select 'bron', null, 'geen complete lading'
where not exists (select 1 from ce_private.loads where status = 'complete');

