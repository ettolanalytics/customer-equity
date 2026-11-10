-- Customer Equity · migratie 10
-- Controle "afgesloten kwartaal ongewijzigd" met een tolerantie in plaats van exacte gelijkheid.
-- Op een andere machine (GitHub-runner tegenover lokaal) rekenen exp, log en digamma in de
-- laatste bits anders; afgeronde bedragen kunnen dan een cent verspringen. scripts/sbg.py brengt
-- het optimum nu met Newton-stappen op ~1e-12, zodat die verschillen ~1e-6 euro zijn.
-- Tolerantie per getal: 0,011 absoluut (één cent afronding) plus 1e-9 relatief. Aantallen
-- (gehele getallen) en elke echte wijziging in de data vallen daar ruim buiten.

create or replace function ce_private.jsonb_close(a jsonb, b jsonb)
returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select case
    when jsonb_typeof(a) is distinct from jsonb_typeof(b) then false
    when jsonb_typeof(a) = 'number' then
      abs((a #>> '{}')::numeric - (b #>> '{}')::numeric)
        <= 0.011 + 1e-9 * abs((b #>> '{}')::numeric)
    when jsonb_typeof(a) = 'object' then
      (select array_agg(k order by k) from jsonb_object_keys(a) k)
        is not distinct from (select array_agg(k order by k) from jsonb_object_keys(b) k)
      and coalesce((select bool_and(ce_private.jsonb_close(a -> k, b -> k)) from jsonb_object_keys(a) k), true)
    when jsonb_typeof(a) = 'array' then
      jsonb_array_length(a) = jsonb_array_length(b)
      and coalesce((select bool_and(ce_private.jsonb_close(a -> (i::int - 1), b -> (i::int - 1)))
                    from generate_series(1, jsonb_array_length(a)) i), true)
    else a = b
  end
$$;
revoke all on function ce_private.jsonb_close(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function ce_private.jsonb_close(jsonb, jsonb) to ce_loader;

create or replace view ce_private.publication_checks_v2 with (security_invoker = true) as
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
where not ce_private.jsonb_close(j.data, o.data)
union all
-- (11) Bron: de laatste lading is complete
select 'bron', null, 'geen complete lading'
where not exists (select 1 from ce_private.loads where status = 'complete');

