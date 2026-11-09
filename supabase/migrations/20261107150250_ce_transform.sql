-- Customer Equity · migratie 4/5
-- Transformatie: de rekenregels uit CLAUDE.md als materialized views in ce_private,
-- de controles als view, en één functie die ververst, controleert en publiceert.
--
-- Referentie-implementatie: scripts/build_quarters.py (Python/DuckDB). Deze SQL moet
-- daar exact mee overeenkomen (scripts/compare_sql_python.py).
--
-- Volgorde (elke view leest alleen uit eerdere):
--   mv_spells         aaneengesloten actieve periodes per klant
--   mv_quarter_flows  klantenstroom per kwartaal (stay/new/returning/churned/inout)
--   mv_quarter_money  omzet en marge per kwartaal
--   mv_quarters       kwartaalcijfers: churn%, marge, verwachte churn, retentie, CLV, CE
--   mv_quarters_json  per dashboardkwartaal het object uit src/lib/quarters.ts
--   mv_publication    aannames, herkomst en kiesbare kwartalen
-- De views worden aangemaakt zonder data; de eerste vulling gebeurt in refresh_and_publish().

-- ---------------------------------------------------------------------------
-- 1. Hulpfuncties
-- ---------------------------------------------------------------------------
-- CLV: som over k = 1..horizon van marge x (retentie / (1 + kwartaaldisconto))^k.
create function ce_private.clv(
  margin double precision, retention double precision, dq double precision, horizon integer
) returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  select margin * sum(power(retention / (1 + dq), k::double precision))
  from generate_series(1, horizon) as k
$$;

-- Verschil met een eerder kwartaal: {abs, pct}; null als er geen eerder kwartaal is.
create function ce_private.change_json(cur double precision, base double precision)
returns jsonb
language sql immutable parallel safe set search_path = ''
as $$
  select case when base is null then null
              else jsonb_build_object('abs', round((cur - base)::numeric, 4),
                                      'pct', round(((cur - base) / base)::numeric, 6)) end
$$;

-- Verschil in een fractie (x 100 = procentpunten); null zonder eerder kwartaal.
create function ce_private.rate_change(cur double precision, base double precision)
returns numeric
language sql immutable parallel safe set search_path = ''
as $$
  select round((cur - base)::numeric, 8)
$$;

-- Waterfall tegen de CLV aan het begin (V0). CLV-verandering gesplitst:
-- Vm = CLV met de marge van het eind en de retentie van het begin;
-- marge-effect = (Vm - V0) x N1, retentie-effect = (V1 - Vm) x N1.
-- expected = true: kwartaal (verwachte churn + verschil), false: jaar (churn).
-- _deviation = verandering - som van de posten (voor de controle; niet gepubliceerd).
create function ce_private.waterfall(
  from_label text, to_label text,
  ce0 double precision, ce1 double precision, n0 bigint, n1 bigint,
  v0 double precision, v1 double precision, m0 double precision, m1 double precision,
  r0 double precision, r1 double precision,
  new_n bigint, reacq_n bigint, churn_n bigint, exp_churn double precision, expected boolean,
  dq double precision, horizon integer
) returns jsonb
language sql immutable set search_path = ''
as $$
  with x as (
    select ce_private.clv(m1, r0, dq, horizon) as vm, ce1 - ce0 as delta
  ), p as (
    select x.delta,
           new_n * v0                                            as p_new,
           reacq_n * v0                                          as p_reacq,
           case when not expected then -churn_n * v0 end         as p_churn,
           case when expected then -exp_churn * v0 end           as p_exp,
           case when expected then (exp_churn - churn_n) * v0 end as p_cve,
           (x.vm - v0) * n1                                      as p_margin,
           (v1 - x.vm) * n1                                      as p_ret
    from x
  )
  select jsonb_build_object(
    'fromLabel', from_label,
    'toLabel', to_label,
    'equityBegin', round(ce0::numeric, 2),
    'equityEnd', round(ce1::numeric, 2),
    'equityChange', round(delta::numeric, 2),
    'equityChangePct', round((delta / ce0)::numeric, 6),
    'parts', jsonb_strip_nulls(jsonb_build_object(
      'newCustomers', round(p_new::numeric, 2),
      'reacquiredCustomers', round(p_reacq::numeric, 2),
      'churn', round(p_churn::numeric, 2),
      'expectedChurn', round(p_exp::numeric, 2),
      'churnVsExpected', round(p_cve::numeric, 2),
      'marginEffect', round(p_margin::numeric, 2),
      'retentionEffect', round(p_ret::numeric, 2))),
    'counts', jsonb_strip_nulls(jsonb_build_object(
      'newCustomers', new_n,
      'reacquiredCustomers', reacq_n,
      'churn', churn_n,
      'expectedChurn', case when expected then round(exp_churn::numeric, 1) end,
      'churnVsExpected', case when expected then round((exp_churn - churn_n)::numeric, 1) end)),
    'customersBegin', n0,
    'customersEnd', n1,
    'avgClvBegin', round(v0::numeric, 4),
    'avgClvEnd', round(v1::numeric, 4),
    'marginBegin', round(m0::numeric, 4),
    'marginEnd', round(m1::numeric, 4),
    'retentionBegin', round(r0::numeric, 6),
    'retentionEnd', round(r1::numeric, 6),
    '_deviation', delta - (p_new + p_reacq + coalesce(p_churn, 0) + coalesce(p_exp, 0)
                           + coalesce(p_cve, 0) + p_margin + p_ret))
  from p
$$;

-- ---------------------------------------------------------------------------
-- 2. mv_spells: aaneengesloten actieve periodes per klant
-- ---------------------------------------------------------------------------
-- Een klant is actief op dag d als de geldende factuur (laatste factuur op of vóór d)
-- vervalt + respijt ná d. Een volgende factuur op of vóór vervaldatum + respijt hoort
-- dus bij dezelfde periode. active_until = vervaldatum laatste factuur + respijt
-- (exclusief: actief op d als spell_start <= d < active_until).
create materialized view ce_private.mv_spells as
with s as (
  select grace_days as g from ce_private.settings
), t as (
  select i.customer_id, i.invoice_date, i.expire_date, s.g,
         case when lag(i.expire_date) over w + s.g >= i.invoice_date then 0 else 1 end as starts_spell
  from ce_private.invoices i cross join s
  window w as (partition by i.customer_id order by i.invoice_date)
), n as (
  select *, sum(starts_spell) over (partition by customer_id order by invoice_date) as spell_no
  from t
)
select customer_id,
       spell_no::integer                                               as spell_no,
       min(invoice_date)                                               as spell_start,
       (array_agg(expire_date order by invoice_date desc))[1] + min(g) as active_until
from n
group by customer_id, spell_no
with no data;

create unique index mv_spells_pk on ce_private.mv_spells (customer_id, spell_no);
create index mv_spells_range on ce_private.mv_spells (spell_start, active_until);

-- ---------------------------------------------------------------------------
-- 3. mv_quarter_flows: klantenstroom per kwartaal
-- ---------------------------------------------------------------------------
-- Elke klant met een periode die het kwartaal raakt, valt in precies één groep:
--   stay       actief begin en eind
--   new        niet actief begin, wel eind, eerste factuur ooit in dit kwartaal
--   returning  niet actief begin, wel eind, eerder al klant
--   churned    actief begin, niet eind; de respijt van de geldende factuur liep af in het kwartaal
--   unexplained  actief begin, niet eind, maar de respijt liep niet in het kwartaal af (mag niet)
--   inout      niet actief begin en eind, wel een factuur in het kwartaal
-- active_d0/active_d1 tellen de actieve klanten los van de groepen (voor de controle).
create materialized view ce_private.mv_quarter_flows as
with q as (
  select gs::date                                             as qs,
         (gs - interval '1 day')::date                         as d0,
         (gs + interval '3 months' - interval '1 day')::date   as d1
  from ce_private.settings s,
       generate_series(s.first_calc_quarter, s.last_quarter, interval '3 months') as gs
), firsts as (
  select customer_id, min(spell_start) as first_invoice
  from ce_private.mv_spells
  group by customer_id
), c as (
  select q.qs, q.d1, sp.customer_id,
         bool_or(sp.spell_start <= q.d0 and q.d0 < sp.active_until) as a0,
         bool_or(sp.spell_start <= q.d1 and q.d1 < sp.active_until) as a1,
         max(sp.active_until)                                       as lapse_grace
  from q
  join ce_private.mv_spells sp on sp.spell_start <= q.d1 and sp.active_until > q.d0
  group by q.qs, q.d1, sp.customer_id
), g as (
  select c.qs,
         case
           when c.a0 and c.a1 then 'stay'
           when c.a1 then case when f.first_invoice >= c.qs then 'new' else 'returning' end
           when c.a0 then case when c.lapse_grace between c.qs and c.d1 then 'churned' else 'unexplained' end
           else 'inout'
         end as grp
  from c join firsts f using (customer_id)
), counts as (
  select qs,
         count(*) filter (where grp = 'stay')        as stay,
         count(*) filter (where grp = 'new')         as new,
         count(*) filter (where grp = 'returning')   as reacquired,
         count(*) filter (where grp = 'churned')     as churned,
         count(*) filter (where grp = 'inout')       as inout,
         count(*) filter (where grp = 'unexplained') as unexplained
  from g
  group by qs
)
select q.qs,
       'Q' || extract(quarter from q.qs)::int || ' ' || extract(year from q.qs)::int as label,
       coalesce(k.stay, 0)        as stay,
       coalesce(k.new, 0)         as new,
       coalesce(k.reacquired, 0)   as reacquired,
       coalesce(k.churned, 0)     as churned,
       coalesce(k.inout, 0)       as inout,
       coalesce(k.unexplained, 0) as unexplained,
       coalesce(k.stay, 0) + coalesce(k.churned, 0) + coalesce(k.unexplained, 0) as begin_groups,
       coalesce(k.stay, 0) + coalesce(k.new, 0) + coalesce(k.reacquired, 0)       as end_groups,
       (select count(distinct sp.customer_id) from ce_private.mv_spells sp
         where sp.spell_start <= q.d0 and q.d0 < sp.active_until)              as active_d0,
       (select count(distinct sp.customer_id) from ce_private.mv_spells sp
         where sp.spell_start <= q.d1 and q.d1 < sp.active_until)              as active_d1
from q
left join counts k using (qs)
with no data;

create unique index mv_quarter_flows_pk on ce_private.mv_quarter_flows (qs);

-- ---------------------------------------------------------------------------
-- 4. mv_quarter_money: omzet en marge per kwartaal (marge = prijs - kostprijs per factuur)
-- ---------------------------------------------------------------------------
create materialized view ce_private.mv_quarter_money as
select date_trunc('quarter', i.invoice_date)::date     as qs,
       sum(i.amount_eur)                                as revenue_eur,
       sum(i.amount_eur - s.cost_per_invoice_eur)       as margin_eur,
       count(*)                                         as invoices
from ce_private.invoices i
cross join ce_private.settings s
group by 1
with no data;

create unique index mv_quarter_money_pk on ce_private.mv_quarter_money (qs);

-- ---------------------------------------------------------------------------
-- 5. mv_quarters: kwartaalcijfers (alle rekenkwartalen)
-- ---------------------------------------------------------------------------
-- Verwachte churn: churn% van hetzelfde kwartaal vorig jaar x actief begin.
-- Retentie: 1 - gemiddeld churn% van de vorige 4 kwartalen (of van de kwartalen
-- die er zijn); zijn er geen, dan 1 - churn% van dit kwartaal.
create materialized view ce_private.mv_quarters as
with s as (
  select first_dashboard_quarter, horizon_quarters,
         power(1 + discount_rate_year, 0.25) - 1 as dq
  from ce_private.settings
), b as (
  select f.qs, f.label,
         f.begin_groups as active_begin,
         f.end_groups   as active_end,
         f.new, f.reacquired, f.churned,
         case when f.begin_groups > 0 then f.churned::double precision / f.begin_groups end as churn_rate,
         coalesce(m.revenue_eur, 0)::double precision                                     as revenue_eur,
         coalesce(m.margin_eur, 0)::double precision
           / nullif((f.begin_groups + f.end_groups) / 2.0::double precision, 0)          as margin_per_customer
  from ce_private.mv_quarter_flows f
  left join ce_private.mv_quarter_money m using (qs)
), w as (
  select b.*,
         lag(churn_rate, 4) over o                                         as expected_churn_rate,
         avg(churn_rate)   over (o rows between 4 preceding and 1 preceding) as prior_avg,
         count(churn_rate) over (o rows between 4 preceding and 1 preceding) as prior_n
  from b
  window o as (order by qs)
), r as (
  select w.*,
         w.expected_churn_rate * w.active_begin                                as expected_churn,
         case when w.prior_n > 0 then 1 - w.prior_avg else 1 - w.churn_rate end as retention,
         w.prior_n::integer                                                    as retention_quarters
  from w
)
select r.qs, r.label, r.active_begin, r.active_end, r.new, r.reacquired, r.churned,
       r.churn_rate, r.revenue_eur, r.margin_per_customer,
       r.expected_churn_rate, r.expected_churn, r.retention, r.retention_quarters,
       ce_private.clv(r.margin_per_customer, r.retention, s.dq, s.horizon_quarters)             as avg_clv,
       r.active_end * ce_private.clv(r.margin_per_customer, r.retention, s.dq, s.horizon_quarters) as customer_equity,
       r.qs >= s.first_dashboard_quarter                                                        as is_dashboard
from r cross join s
with no data;

create unique index mv_quarters_pk on ce_private.mv_quarters (qs);

-- ---------------------------------------------------------------------------
-- 6. mv_quarters_json: per dashboardkwartaal het object voor de app
-- ---------------------------------------------------------------------------
-- Alleen getallen, kwartaallabels en structuur. Vergelijkingen met vorig kwartaal en
-- met een jaar eerder (binnen de dashboardkwartalen), antwoordzin-cijfers (yearSummary),
-- rekenvoorbeeld-cijfers (clvExample) en beide waterfalls.
create materialized view ce_private.mv_quarters_json as
with s as (
  select horizon_quarters as h, power(1 + discount_rate_year, 0.25) - 1 as dq
  from ce_private.settings
), d as (
  select row_number() over (order by qs)::integer as seq, q.*
  from ce_private.mv_quarters q
  where q.is_dashboard
), w as (
  select d.*,
         d.new + d.reacquired                                    as acquired,
         (sum(d.new)       over l4)::bigint                       as new4,
         (sum(d.reacquired) over l4)::bigint                       as reacq4,
         (sum(d.churned)   over l4)::bigint                       as churn4,
         (sum(d.new + d.reacquired) over l4)::bigint               as acquired4,
         count(d.expected_churn) over l4                         as exp_n4,
         sum(d.expected_churn - d.churned) over l4               as cve4
  from d
  window l4 as (order by seq rows between 3 preceding and current row)
), j as (
  select c.seq, c.label, c.qs,
         c.active_begin, c.active_end, c.new, c.reacquired, c.churned, c.acquired,
         c.churn_rate, c.avg_clv, c.customer_equity, c.margin_per_customer, c.retention,
         -- Kwartaalwaterfall: alleen met een vorig kwartaal en verwachte churn.
         case when p.seq is not null and c.expected_churn is not null then
           ce_private.waterfall(p.label, c.label, p.customer_equity, c.customer_equity,
                                p.active_end, c.active_end, p.avg_clv, c.avg_clv,
                                p.margin_per_customer, c.margin_per_customer, p.retention, c.retention,
                                c.new, c.reacquired, c.churned, c.expected_churn, true, s.dq, s.h)
         end as wf,
         -- Jaarwaterfall: daarnaast een kwartaal een jaar eerder (vier kwartalen terug).
         case when p.seq is not null and c.expected_churn is not null and ya.seq is not null then
           ce_private.waterfall(ya.label, c.label, ya.customer_equity, c.customer_equity,
                                ya.active_end, c.active_end, ya.avg_clv, c.avg_clv,
                                ya.margin_per_customer, c.margin_per_customer, ya.retention, c.retention,
                                c.new4, c.reacq4, c.churn4, null::double precision, false, s.dq, s.h)
         end as ywf,
         jsonb_build_object(
           'label', c.label,
           'activeBegin', c.active_begin,
           'activeEnd', c.active_end,
           'newCustomers', c.new,
           'reacquiredCustomers', c.reacquired,
           'acquiredCustomers', c.acquired,
           'churn', c.churned,
           'expectedChurn', round(c.expected_churn::numeric, 1),
           'churnRate', round(c.churn_rate::numeric, 6),
           'expectedChurnRate', round(c.expected_churn_rate::numeric, 6),
           'churnRateVsExpected', round((c.churn_rate - c.expected_churn_rate)::numeric, 6),
           'revenueEur', round(c.revenue_eur::numeric, 2),
           'marginPerCustomer', c.margin_per_customer,
           'retention', c.retention,
           'retentionQuarters', c.retention_quarters,
           'avgClv', c.avg_clv,
           'customerEquity', round(c.customer_equity::numeric, 2),
           'churnVsExpectedCount', round((c.churned - c.expected_churn)::numeric, 1)
         )
         || jsonb_build_object(
           'equityVsPrevQuarter',    ce_private.change_json(c.customer_equity, p.customer_equity),
           'equityVsYearAgo',        ce_private.change_json(c.customer_equity, ya.customer_equity),
           'acquiredVsPrevQuarter',  ce_private.change_json(c.acquired, p.acquired),
           'acquiredVsYearAgo',      ce_private.change_json(c.acquired, ya.acquired),
           'churnRateVsPrevQuarter', ce_private.rate_change(c.churn_rate, p.churn_rate),
           'churnRateVsYearAgo',     ce_private.rate_change(c.churn_rate, ya.churn_rate),
           'avgClvVsPrevQuarter',    ce_private.change_json(c.avg_clv, p.avg_clv),
           'avgClvVsYearAgo',        ce_private.change_json(c.avg_clv, ya.avg_clv),
           'activeVsPrevQuarter',    ce_private.change_json(c.active_end, p.active_end),
           'activeVsYearAgo',        ce_private.change_json(c.active_end, ya.active_end),
           'newVsPrevQuarter',       ce_private.change_json(c.new, p.new),
           'newVsYearAgo',           ce_private.change_json(c.new, ya.new),
           'reacquiredVsPrevQuarter', ce_private.change_json(c.reacquired, p.reacquired),
           'reacquiredVsYearAgo',    ce_private.change_json(c.reacquired, ya.reacquired),
           'churnVsPrevQuarter',     ce_private.change_json(c.churned, p.churned),
           'churnVsYearAgo',         ce_private.change_json(c.churned, ya.churned),
           'marginVsPrevQuarter',    ce_private.change_json(c.margin_per_customer, p.margin_per_customer),
           'marginVsYearAgo',        ce_private.change_json(c.margin_per_customer, ya.margin_per_customer),
           'retentionVsPrevQuarter', ce_private.rate_change(c.retention, p.retention),
           'retentionVsYearAgo',     ce_private.rate_change(c.retention, ya.retention),
           'yearSummary', case when ya.seq is not null then jsonb_build_object(
               'acquiredCustomers', c.acquired4,
               'newCustomers', c.new4,
               'reacquiredCustomers', c.reacq4,
               'avgClvChange', round((c.avg_clv - ya.avg_clv)::numeric, 4),
               'churnQuarters', c.exp_n4,
               'churnVsExpected', case when c.exp_n4 > 0 then round(c.cve4::numeric, 1) end)
             end,
           'clvExample', (
             select jsonb_build_object(
                      'churnRate', round((1 - c.retention)::numeric, 6),
                      'expectedQuarters', e.quarters,
                      'undiscountedValue', round((c.margin_per_customer * e.quarters::double precision)::numeric, 4))
             from (select round((c.retention * (1 - power(c.retention, s.h)) / (1 - c.retention))::numeric, 1)
                          as quarters) e)
         ) as base
  from w c
  cross join s
  left join w p  on p.seq  = c.seq - 1
  left join w ya on ya.seq = c.seq - 4
)
select seq, label, qs,
       base || jsonb_build_object('waterfall', wf - '_deviation', 'yearWaterfall', ywf - '_deviation') as data,
       (wf ->> '_deviation')::double precision  as wf_deviation,
       (ywf ->> '_deviation')::double precision as ywf_deviation
from j
with no data;

create unique index mv_quarters_json_pk on ce_private.mv_quarters_json (seq);

-- ---------------------------------------------------------------------------
-- 7. mv_publication: aannames, herkomst en kiesbare kwartalen (één rij)
-- ---------------------------------------------------------------------------
-- Kiesbaar = alle onderdelen van het scherm gevuld (zoals src/lib/quarters.ts selecteert).
create materialized view ce_private.mv_publication as
select 1::smallint                                    as id,
       now()                                          as generated_at,
       (select r.generator_version from ce_private.generator_runs r order by r.id desc limit 1)
                                                      as generator_version,
       s.discount_rate_year,
       s.horizon_quarters,
       s.grace_days,
       s.price_eur,
       s.cost_per_invoice_eur,
       s.price_eur - s.cost_per_invoice_eur           as margin_per_invoice_eur,
       (select j.label from ce_private.mv_quarters_json j
         where jsonb_typeof(j.data -> 'waterfall') = 'object'
           and jsonb_typeof(j.data -> 'yearWaterfall') = 'object'
           and jsonb_typeof(j.data -> 'equityVsYearAgo') = 'object'
           and jsonb_typeof(j.data -> 'yearSummary') = 'object'
         order by j.seq limit 1)                      as first_selectable,
       (select j.label from ce_private.mv_quarters_json j order by j.seq desc limit 1) as last_quarter,
       (select count(*) from ce_private.mv_quarters_json)::integer                    as quarter_count
from ce_private.settings s
with no data;

-- ---------------------------------------------------------------------------
-- 8. publication_checks: elke rij is een fout. Leeg = publiceren mag.
-- ---------------------------------------------------------------------------
create view ce_private.publication_checks with (security_invoker = true) as
with s as (
  select *, power(1 + discount_rate_year, 0.25) - 1 as dq from ce_private.settings
), j as (
  select seq, label, data,
         (data ->> 'activeBegin')::bigint          as active_begin,
         (data ->> 'activeEnd')::bigint            as active_end,
         (data ->> 'newCustomers')::bigint         as new,
         (data ->> 'reacquiredCustomers')::bigint  as reacq,
         (data ->> 'churn')::bigint                as churn,
         (data ->> 'avgClv')::double precision     as avg_clv,
         (data ->> 'customerEquity')::double precision    as ce,
         (data ->> 'marginPerCustomer')::double precision as margin,
         (data ->> 'retention')::double precision         as retention,
         wf_deviation, ywf_deviation
  from ce_private.mv_quarters_json
), expected_keys as (
  select array[
    'label', 'activeBegin', 'activeEnd', 'newCustomers', 'reacquiredCustomers', 'acquiredCustomers',
    'churn', 'expectedChurn', 'churnRate', 'expectedChurnRate', 'churnRateVsExpected', 'revenueEur',
    'marginPerCustomer', 'retention', 'retentionQuarters', 'avgClv', 'customerEquity',
    'equityVsPrevQuarter', 'equityVsYearAgo', 'acquiredVsPrevQuarter', 'acquiredVsYearAgo',
    'churnRateVsPrevQuarter', 'churnRateVsYearAgo', 'avgClvVsPrevQuarter', 'avgClvVsYearAgo',
    'activeVsPrevQuarter', 'activeVsYearAgo', 'newVsPrevQuarter', 'newVsYearAgo',
    'reacquiredVsPrevQuarter', 'reacquiredVsYearAgo', 'churnVsPrevQuarter', 'churnVsYearAgo',
    'marginVsPrevQuarter', 'marginVsYearAgo', 'retentionVsPrevQuarter', 'retentionVsYearAgo',
    'churnVsExpectedCount', 'yearSummary', 'clvExample', 'waterfall', 'yearWaterfall'
  ]::text[] as quarter_keys,
  array[
    'fromLabel', 'toLabel', 'equityBegin', 'equityEnd', 'equityChange', 'equityChangePct', 'parts',
    'counts', 'customersBegin', 'customersEnd', 'avgClvBegin', 'avgClvEnd', 'marginBegin', 'marginEnd',
    'retentionBegin', 'retentionEnd'
  ]::text[] as waterfall_keys
)
-- (1) Klantenstroom sluit, in elk rekenkwartaal
select 'stroom'::text as check_name, f.label as item,
       format('begin %s vs groepen %s, eind %s vs groepen %s, onverklaard %s',
              f.active_d0, f.begin_groups, f.active_d1, f.end_groups, f.unexplained) as detail
from ce_private.mv_quarter_flows f
where f.unexplained <> 0 or f.begin_groups <> f.active_d0 or f.end_groups <> f.active_d1
   or f.active_d0 + f.new + f.reacquired - f.churned - f.active_d1 <> 0
union all
-- (2) Waterfalls tellen op tot de verandering (afwijking < 1 euro)
select 'waterfall', j.label, format('kwartaal %s, jaar %s', j.wf_deviation, j.ywf_deviation)
from j
where abs(coalesce(j.wf_deviation, 0)) >= 1 or abs(coalesce(j.ywf_deviation, 0)) >= 1
union all
-- (3a) Customer equity = actieve klanten x gemiddelde CLV (afwijking <= 1 euro)
select 'driver_a', j.label, format('afwijking %s', j.active_end * j.avg_clv - j.ce)
from j
where abs(j.active_end * j.avg_clv - j.ce) > 1
union all
-- (3b) Actieve klanten = vorig kwartaal + new + reacquired - churn (exact)
select 'driver_b', j.label,
       format('vorig %s + %s + %s - %s <> %s (begin %s)', coalesce(p.active_end, j.active_begin),
              j.new, j.reacq, j.churn, j.active_end, j.active_begin)
from j left join j p on p.seq = j.seq - 1
where coalesce(p.active_end, j.active_begin) + j.new + j.reacq - j.churn <> j.active_end
   or j.active_begin <> coalesce(p.active_end, j.active_begin)
union all
-- (3c) Gemiddelde CLV volgt uit marge en retentie (afwijking x klanten <= 1 euro)
select 'driver_c', j.label,
       format('afwijking %s', (ce_private.clv(j.margin, j.retention, s.dq, s.horizon_quarters) - j.avg_clv) * j.active_end)
from j cross join s
where abs((ce_private.clv(j.margin, j.retention, s.dq, s.horizon_quarters) - j.avg_clv) * j.active_end) > 1
union all
-- (4) Vorm: precies de sleutels uit src/lib/quarters.ts, waterfalls null of compleet
select 'vorm_sleutels', j.label, 'sleutels wijken af van het type Quarter'
from j cross join expected_keys k
where not (array(select jsonb_object_keys(j.data) order by 1) = array(select unnest(k.quarter_keys) order by 1))
union all
select 'vorm_waterfall', j.label, wf.key
from j cross join expected_keys k
cross join lateral (values ('waterfall'), ('yearWaterfall')) as wf(key)
where jsonb_typeof(j.data -> wf.key) not in ('null', 'object')
   or (jsonb_typeof(j.data -> wf.key) = 'object'
       and not (array(select jsonb_object_keys(j.data -> wf.key) order by 1)
                = array(select unnest(k.waterfall_keys) order by 1)))
union all
-- (5) Vorm: verplichte getallen zijn getallen (geen null door deling door nul)
select 'vorm_getal', j.label, key
from j cross join unnest(array['activeBegin', 'activeEnd', 'churnRate', 'marginPerCustomer',
                               'retention', 'avgClv', 'customerEquity', 'revenueEur']) as key
where jsonb_typeof(j.data -> key) is distinct from 'number'
union all
-- (6) Vorm: de enige tekst is een kwartaallabel (geen zinnen in de data)
select 'vorm_tekst', j.label, v #>> '{}'
from j cross join lateral jsonb_path_query(j.data, 'strict $.**') as v
where jsonb_typeof(v) = 'string' and (v #>> '{}') !~ '^Q[1-4] [0-9]{4}$'
union all
-- (7) Volledigheid: alle kwartalen van first_dashboard_quarter t/m last_quarter, oplopend
select 'volledig', null,
       format('%s kwartalen, verwacht %s; laatste %s', n.cnt, n.expected, n.last_label)
from (
  select (select count(*) from ce_private.mv_quarters_json) as cnt,
         (select count(*) from ce_private.settings s2,
                 generate_series(s2.first_dashboard_quarter, s2.last_quarter, interval '3 months')) as expected,
         (select max(seq) from ce_private.mv_quarters_json) as max_seq,
         (select label from ce_private.mv_quarters_json order by seq desc limit 1) as last_label,
         (select 'Q' || extract(quarter from last_quarter)::int || ' ' || extract(year from last_quarter)::int
            from ce_private.settings) as expected_last
) n
where n.cnt = 0 or n.cnt <> n.expected or n.max_seq <> n.cnt or n.last_label is distinct from n.expected_last
union all
-- (8) Publicatie: één rij, met generatorversie en minstens één kiesbaar kwartaal
select 'publicatie', null, 'geen generatorrun of geen kiesbaar kwartaal'
where not exists (select 1 from ce_private.mv_publication
                  where generator_version is not null and first_selectable is not null)
union all
-- (9) Bron: aantal facturen = aantal uit de laatste generatorrun
select 'bron', null, format('%s facturen, generatorrun zegt %s', i.cnt, r.rows)
from (select count(*) as cnt from ce_private.invoices) i
left join lateral (select rows from ce_private.generator_runs order by id desc limit 1) r on true
where r.rows is distinct from i.cnt;

-- ---------------------------------------------------------------------------
-- 9. refresh_and_publish(): verversen, controleren, publiceren — of niets
-- ---------------------------------------------------------------------------
-- Alles binnen één blok met exception-handler (een savepoint): faalt een controle of
-- een stap, dan wordt het hele blok teruggedraaid (ook de views en ce_public) en komt
-- alleen de fout in refresh_log. Geeft 'published' of 'failed: ...' terug.
create function ce_private.refresh_and_publish()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_fail    jsonb;
  v_n       integer;
  v_msg     text;
  v_detail  text;
begin
  begin
    refresh materialized view ce_private.mv_spells;
    refresh materialized view ce_private.mv_quarter_flows;
    refresh materialized view ce_private.mv_quarter_money;
    refresh materialized view ce_private.mv_quarters;
    refresh materialized view ce_private.mv_quarters_json;
    refresh materialized view ce_private.mv_publication;

    select jsonb_agg(to_jsonb(c)) into v_fail from ce_private.publication_checks c;
    if v_fail is not null then
      raise exception 'controles mislukt (%)', jsonb_array_length(v_fail)
        using detail = v_fail::text;
    end if;

    delete from ce_public.quarters;
    insert into ce_public.quarters (seq, label, data)
    select seq, label, data from ce_private.mv_quarters_json order by seq;
    get diagnostics v_n = row_count;

    delete from ce_public.publication;
    insert into ce_public.publication
      (id, generated_at, generator_version, discount_rate_year, horizon_quarters, grace_days,
       price_eur, cost_per_invoice_eur, margin_per_invoice_eur, first_selectable, last_quarter,
       quarter_count)
    select id, generated_at, generator_version, discount_rate_year, horizon_quarters, grace_days,
           price_eur, cost_per_invoice_eur, margin_per_invoice_eur, first_selectable, last_quarter,
           quarter_count
    from ce_private.mv_publication;

    insert into ce_private.refresh_log (started_at, status, message)
    values (v_started, 'published', format('%s kwartalen gepubliceerd', v_n));
    return 'published';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    insert into ce_private.refresh_log (started_at, status, message, details)
    values (v_started, 'failed', v_msg,
            case when v_detail like '[%' then v_detail::jsonb
                 when v_detail <> '' then to_jsonb(v_detail) end);
    return 'failed: ' || v_msg;
  end;
end
$$;

comment on function ce_private.refresh_and_publish() is
  'Ververst de materialized views, draait publication_checks en vervangt ce_public alleen als '
  'alle controles slagen. Resultaat in ce_private.refresh_log.';

-- ---------------------------------------------------------------------------
-- 10. Rechten
-- ---------------------------------------------------------------------------
revoke all on ce_private.mv_spells, ce_private.mv_quarter_flows, ce_private.mv_quarter_money,
              ce_private.mv_quarters, ce_private.mv_quarters_json, ce_private.mv_publication,
              ce_private.publication_checks
  from public, anon, authenticated, service_role;
revoke all on function ce_private.clv(double precision, double precision, double precision, integer),
                       ce_private.change_json(double precision, double precision),
                       ce_private.rate_change(double precision, double precision),
                       ce_private.waterfall(text, text, double precision, double precision, bigint, bigint,
                                            double precision, double precision, double precision,
                                            double precision, double precision, double precision,
                                            bigint, bigint, bigint, double precision, boolean,
                                            double precision, integer),
                       ce_private.refresh_and_publish()
  from public, anon, authenticated, service_role;

-- ce_loader: lezen ter controle (vergelijking met de Python-referentie) en de refresh starten.
grant select on ce_private.mv_spells, ce_private.mv_quarter_flows, ce_private.mv_quarter_money,
                ce_private.mv_quarters, ce_private.mv_quarters_json, ce_private.mv_publication,
                ce_private.publication_checks
  to ce_loader;
grant execute on function ce_private.clv(double precision, double precision, double precision, integer)
  to ce_loader;
grant execute on function ce_private.refresh_and_publish() to ce_loader;
