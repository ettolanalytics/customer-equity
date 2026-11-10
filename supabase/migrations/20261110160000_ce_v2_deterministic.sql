-- Customer Equity · migratie 9
-- Publicatie v2 deterministisch. De controle "afgesloten kwartaal ongewijzigd" faalde op de
-- tweede publicatie: onafgeronde getallen (gemiddelde CLV e.d.) verschilden in de laatste bits
-- van een double, omdat Postgres parallel en dus in wisselende volgorde optelt.
--   1. refresh_v2_base() en publish_v2(): geen parallelle aggregatie (vaste volgorde).
--   2. De controle vergelijkt alle getallen afgerond op 6 decimalen (jsonb_round).
-- De rest van migratie 8 blijft gelijk.

-- Alle getallen in een jsonb-waarde afgerond op d decimalen (recursief).
create or replace function ce_private.jsonb_round(v jsonb, d integer)
returns jsonb
language sql immutable parallel safe set search_path = ''
as $$
  select case jsonb_typeof(v)
    when 'number' then to_jsonb(round((v #>> '{}')::numeric, d))
    when 'object' then coalesce((select jsonb_object_agg(k, ce_private.jsonb_round(x, d))
                                 from jsonb_each(v) as e(k, x)), '{}'::jsonb)
    when 'array'  then coalesce((select jsonb_agg(ce_private.jsonb_round(x, d) order by i)
                                 from jsonb_array_elements(v) with ordinality as e(x, i)), '[]'::jsonb)
    else v end
$$;
revoke all on function ce_private.jsonb_round(jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function ce_private.jsonb_round(jsonb, integer) to ce_loader;

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
where ce_private.jsonb_round(j.data, 6) <> ce_private.jsonb_round(o.data, 6)
union all
-- (11) Bron: de laatste lading is complete
select 'bron', null, 'geen complete lading'
where not exists (select 1 from ce_private.loads where status = 'complete');

-- Stap 1 (vóór de schatting): de afgeleide views uit bz_*.
create or replace function ce_private.refresh_v2_base()
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  set local statement_timeout = '10min';
  set local max_parallel_workers_per_gather = 0;  -- vaste volgorde van optellen
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
begin
  begin
    set local statement_timeout = '10min';
    set local max_parallel_workers_per_gather = 0;  -- vaste volgorde van optellen
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

revoke all on function ce_private.refresh_v2_base(), ce_private.publish_v2()
  from public, anon, authenticated, service_role;
grant execute on function ce_private.refresh_v2_base(), ce_private.publish_v2() to ce_loader;
