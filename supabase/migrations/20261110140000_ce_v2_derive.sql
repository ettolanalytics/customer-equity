-- Customer Equity · migratie 7
-- Afleiden uit de Beanrise-data (ce_private.bz_*): klantperioden, toestand per kwartaaleinde,
-- klantenstroom per klantperiode, marge en overstappen per abonnement, invoer voor het
-- sBG-model. Ontwerp: docs/ontwerp-dashboard-v3.md v3.3, §3.2 en §3.3 (lokaal).
--
-- Raakt de oude pijplijn niet (ce_public.quarters, de oude views, refresh_and_publish()).
--
-- Kernregels (§3.2):
--   * alleen betaalde facturen, zoals bekend op de peildatum: known_from = de dag waarop de
--     factuur begonnen én betaald is;
--   * klantperiode per klant: de volgende factuur begint én is betaald vóór vervaldatum + 30 dagen
--     (zolang de klant actief is); anders churn en een nieuwe klantperiode (B19);
--   * actief op peildatum d: known_from <= d < vervaldatum + 30.

-- ---------------------------------------------------------------------------
-- 1. Instellingen (één rij)
-- ---------------------------------------------------------------------------
create table ce_private.settings_v2 (
  id                       smallint primary key default 1 check (id = 1),
  discount_rate_year       double precision not null check (discount_rate_year > 0 and discount_rate_year < 1),
  horizon_months           integer not null check (horizon_months between 1 and 240),
  grace_days               integer not null check (grace_days >= 0),
  first_calc_quarter       date    not null,  -- eerste kwartaal met klantenstroom (churn% vorig jaar)
  first_dashboard_quarter  date    not null,  -- eerste kwartaal in ce_public.quarters_v2
  first_param_quarter      date    not null,  -- eerste kwartaal met α, β (begin van de eerste waterfall)
  holdout_months           integer not null check (holdout_months > 0),
  segmentation             text    not null check (segmentation in ('pooled', 'start_plan')),
  returners                text    not null check (returners in ('separate', 'pooled')),
  margin_method            text    not null check (margin_method in ('current', 'switching'))
);
comment on table ce_private.settings_v2 is
  'Aannames en modelkeuzes voor de sBG-pijplijn. segmentation, returners en margin_method '
  'volgen de holdoutvalidatie (scripts/validate_holdout.py, beslisregels §1.2).';
insert into ce_private.settings_v2 values
  (1, 0.10, 60, 30, date '2019-01-01', date '2020-01-01', date '2019-10-01', 24,
   'start_plan', 'separate', 'current');

-- ---------------------------------------------------------------------------
-- 2. Betaalde facturen met klantperiode (view; niet opgeslagen)
-- ---------------------------------------------------------------------------
create view ce_private.v_bz_paid with (security_invoker = true) as
with s as (
  select grace_days as g from ce_private.settings_v2
), p as (
  select i.customer_id, i.plan_id, i.period_start, i.period_end, i.amount_excl_vat_cents as amount,
         (i.paid_at at time zone 'UTC')::date as paid_on
  from ce_private.bz_invoices i
  where i.status = 1
), b as (
  select p.*, greatest(p.period_start, p.paid_on) as known_from,
         case when lag(p.period_end) over w is not null
               and p.period_start < lag(p.period_end) over w + s.g
               and p.paid_on      < lag(p.period_end) over w + s.g
              then 0 else 1 end as brk
  from p cross join s
  window w as (partition by p.customer_id order by p.period_start, p.paid_on)
), n as (
  select b.*, sum(b.brk) over (partition by b.customer_id order by b.period_start, b.paid_on
                               rows unbounded preceding)::smallint as spell_no
  from b
)
select n.customer_id, n.spell_no, n.plan_id, n.period_start, n.period_end, n.paid_on, n.known_from, n.amount,
       (row_number() over sp)::smallint                     as k,
       first_value(n.plan_id) over sp                       as start_plan,
       lag(n.plan_id) over sp                               as prev_plan,
       coalesce(lead(n.known_from) over sp,
                max(n.period_end) over sa + s.g)            as valid_to,
       max(n.period_end) over sa + s.g                      as spell_end
from n cross join s
window sp as (partition by n.customer_id, n.spell_no order by n.period_start),
       sa as (partition by n.customer_id, n.spell_no);
comment on view ce_private.v_bz_paid is
  'Betaalde facturen met klantperiode (spell_no), volgnummer k in de periode, startabonnement, '
  'vorig abonnement, valid_to (tot wanneer deze factuur de toestand is) en spell_end '
  '(laatste vervaldatum + respijt; de dag van churn als de periode afgelopen is).';

-- ---------------------------------------------------------------------------
-- 3. Toestand per kwartaaleinde: één rij per actieve klant
-- ---------------------------------------------------------------------------
-- Een factuur is de toestand van de klant van known_from tot valid_to (< 62 dagen), dus op
-- hooguit één kwartaaleinde: het eerste kwartaaleinde vanaf known_from.
create materialized view ce_private.mv_bz_state as
with s as (select (first_calc_quarter - 1) as first_qe from ce_private.settings_v2)
select x.qe, x.customer_id, x.spell_no, x.k as n, x.plan_id, x.start_plan,
       (x.spell_no > 1)        as returning,
       (x.qe < x.period_end)   as paid_through
from (
  select v.*, (date_trunc('quarter', v.known_from) + interval '3 months' - interval '1 day')::date as qe
  from ce_private.v_bz_paid v
) x cross join s
where x.qe < x.valid_to and x.qe >= s.first_qe
with no data;
comment on materialized view ce_private.mv_bz_state is
  'Per kwartaaleinde (qe) elke actieve klant: klantperiode, klantduur n, huidig abonnement, '
  'startabonnement, terugkeer, en of hij betaald heeft t/m qe (anders in respijt).';

-- ---------------------------------------------------------------------------
-- 4. Klantperioden (voor churn in de schatting) en klanten
-- ---------------------------------------------------------------------------
create materialized view ce_private.mv_bz_spells as
select customer_id, spell_no, min(known_from) as known_start, max(spell_end) as spell_end,
       count(*)::smallint as n_total, min(start_plan) as start_plan,
       (array_agg(plan_id order by k desc))[1] as last_plan
from ce_private.v_bz_paid
group by customer_id, spell_no
with no data;
comment on materialized view ce_private.mv_bz_spells is
  'Eén rij per klantperiode: bekend vanaf, einde (vervaldatum + respijt), aantal facturen.';

-- ---------------------------------------------------------------------------
-- 5. Maandtotalen per abonnement (marge, omzet, overstappen)
-- ---------------------------------------------------------------------------
-- ps_month: maand van period_start; paid_month: maand waarin de factuur bekend werd.
-- Kostprijzen beginnen altijd op de 1e van een maand (gecontroleerd bij het laden), dus de
-- kostprijs van de maand is die op period_start.
create materialized view ce_private.mv_bz_month as
with m as (
  select v.plan_id, v.prev_plan,
         date_trunc('month', v.period_start)::date as ps_month,
         date_trunc('month', v.known_from)::date   as known_month,
         count(*)                                   as invoices,
         sum(v.amount)                              as amount_cents
  from ce_private.v_bz_paid v
  group by 1, 2, 3, 4
)
select m.*, m.amount_cents - m.invoices * c.cost_cents as margin_cents
from m
join ce_private.bz_product_costs c
  on c.plan_id = m.plan_id
 and c.valid_from <= m.ps_month
 and (c.valid_to is null or c.valid_to > m.ps_month)
with no data;

-- ---------------------------------------------------------------------------
-- 6. Kwartaaleinden van de berekening
-- ---------------------------------------------------------------------------
-- Afgesloten kwartaal: kwartaaleinde vóór as_of van de laatste geslaagde lading (§4.1).
create view ce_private.v_bz_quarters with (security_invoker = true) as
select gs::date as qs,
       (gs + interval '3 months' - interval '1 day')::date as qe,
       'Q' || extract(quarter from gs)::int || ' ' || extract(year from gs)::int as label
from ce_private.settings_v2 s,
     generate_series(s.first_calc_quarter - interval '3 months',
                     (select date_trunc('quarter', as_of)::date - interval '3 months'
                        from ce_private.loads where status = 'complete' order by load_id desc limit 1),
                     interval '3 months') gs;

-- ---------------------------------------------------------------------------
-- 7. Marge en overstapkansen per abonnement, 12 maanden t/m qe
-- ---------------------------------------------------------------------------
create materialized view ce_private.mv_bz_plan_money as
select q.qe, p.plan_id,
       sum(m.invoices)                                         as invoices_12m,
       sum(m.margin_cents)::double precision / 100 / nullif(sum(m.invoices), 0) as margin_eur,
       sum(m.invoices) filter (where m.prev_plan is not null)  as renewals_12m,
       sum(m.invoices) filter (where m.prev_plan is not null and sz.size_grams > szp.size_grams) as ups_12m,
       sum(m.invoices) filter (where m.prev_plan is not null and sz.size_grams < szp.size_grams) as downs_12m
from ce_private.v_bz_quarters q
cross join (select distinct plan_id from ce_private.bz_plans) p
left join ce_private.mv_bz_month m
  on m.plan_id = p.plan_id
 and m.ps_month >  (q.qe - interval '12 months')
 and m.ps_month <= q.qe
 and m.known_month <= q.qe
left join (select distinct plan_id, size_grams from ce_private.bz_plans) sz  on sz.plan_id = m.plan_id
left join (select distinct plan_id, size_grams from ce_private.bz_plans) szp on szp.plan_id = m.prev_plan
group by q.qe, p.plan_id
with no data;
comment on materialized view ce_private.mv_bz_plan_money is
  'Per kwartaaleinde en abonnement: marge per factuur (12 maanden t/m qe, som/som, excl. btw) '
  'en het aantal op- en afschalingen (opeenvolgende facturen in een klantperiode).';

-- Overstapmatrix per maand: van abonnement (prev_plan) naar abonnement, 12 maanden t/m qe.
create view ce_private.v_bz_switch with (security_invoker = true) as
select q.qe, m.prev_plan as from_plan, m.plan_id as to_plan,
       sum(m.invoices)::double precision
         / sum(sum(m.invoices)) over (partition by q.qe, m.prev_plan) as p_month
from ce_private.v_bz_quarters q
join ce_private.mv_bz_month m
  on m.prev_plan is not null
 and m.ps_month >  (q.qe - interval '12 months')
 and m.ps_month <= q.qe
 and m.known_month <= q.qe
group by q.qe, m.prev_plan, m.plan_id;

-- ---------------------------------------------------------------------------
-- 8. Late-verlengfactor g per kwartaaleinde
-- ---------------------------------------------------------------------------
-- Aandeel klanten in respijt op de vier vorige kwartaaleinden (uitkomst bekend: respijt
-- duurt 30 dagen) dat de klantperiode voortzette. Zelfde populatie als die gewaardeerd wordt.
create materialized view ce_private.mv_bz_late as
select q.qe,
       coalesce(sum(case when sp.n_total > st.n then 1 else 0 end)::double precision
                / nullif(count(*), 0), 0) as g,
       count(*) as in_grace_4q
from ce_private.v_bz_quarters q
left join ce_private.mv_bz_state st
  on st.qe < q.qe and st.qe >= (q.qe - interval '12 months')::date and not st.paid_through
left join ce_private.mv_bz_spells sp
  on sp.customer_id = st.customer_id and sp.spell_no = st.spell_no
group by q.qe
with no data;

-- ---------------------------------------------------------------------------
-- 9. Invoer voor het sBG-model
-- ---------------------------------------------------------------------------
-- Per kwartaaleinde: lopende klantperioden (gecensureerd, T >= n) en afgelopen klantperioden
-- (gechurnd, T = n). Ook klantperioden die binnen één kwartaal begonnen en eindigden.
create view ce_private.sbg_input with (security_invoker = true) as
select st.qe, (st.returning)::int + 1 as grp, st.start_plan, st.plan_id as cur_plan,
       st.n, false as churned, count(*) as customers
from ce_private.mv_bz_state st
group by 1, 2, 3, 4, 5
union all
select q.qe, (sp.spell_no > 1)::int + 1, sp.start_plan, sp.last_plan, sp.n_total, true, count(*)
from ce_private.v_bz_quarters q
join ce_private.mv_bz_spells sp on sp.spell_end <= q.qe
group by 1, 2, 3, 4, 5;
comment on view ce_private.sbg_input is
  'Tellingen voor de sBG-schatting per kwartaaleinde: groep (1 eerste, 2 terugkeer), '
  'startabonnement, huidig of laatste abonnement, klantduur n, gechurnd of nog lopend.';

-- ---------------------------------------------------------------------------
-- 10. Klantenstroom per klantperiode (§3.3): paren begin/eind per kwartaal
-- ---------------------------------------------------------------------------
-- flow: S blijvend, L churn, N nieuw, R reacquired. Klantperioden die binnen het kwartaal
-- begonnen en eindigden komen op geen kwartaaleinde voor en tellen dus nergens.
create materialized view ce_private.mv_bz_pairs as
with q as (
  select qs, qe, (qs - 1) as q0 from ce_private.v_bz_quarters
), firsts as (
  select customer_id, min(known_start) as first_known from ce_private.mv_bz_spells group by 1
)
select q.qe,
       case when a.customer_id is not null and b.customer_id is not null then 'S'
            when a.customer_id is not null then 'L'
            when f.first_known <= q.q0 then 'R'
            else 'N' end                                  as flow,
       (coalesce(a.returning, b.returning))::int + 1     as grp,
       coalesce(a.start_plan, b.start_plan)              as start_plan,
       a.n as n0, a.plan_id as plan0, a.paid_through as pt0,
       b.n as n1, b.plan_id as plan1, b.paid_through as pt1,
       count(*)                                          as customers
from q
join ce_private.mv_bz_state x on x.qe in (q.q0, q.qe)
left join ce_private.mv_bz_state a
  on a.qe = q.q0 and a.customer_id = x.customer_id and a.spell_no = x.spell_no
left join ce_private.mv_bz_state b
  on b.qe = q.qe and b.customer_id = x.customer_id and b.spell_no = x.spell_no
left join firsts f on f.customer_id = x.customer_id
where (x.qe = q.qe) or (b.customer_id is null)   -- elke klantperiode één keer
group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
with no data;
comment on materialized view ce_private.mv_bz_pairs is
  'Per kwartaal de klantperioden met hun toestand aan het begin (n0, plan0, pt0) en eind '
  '(n1, plan1, pt1), ingedeeld als S/L/N/R (§3.3), als aantallen.';

-- ---------------------------------------------------------------------------
-- 11. Rechten
-- ---------------------------------------------------------------------------
revoke all on ce_private.settings_v2, ce_private.v_bz_paid, ce_private.mv_bz_state,
              ce_private.mv_bz_spells, ce_private.mv_bz_month, ce_private.v_bz_quarters,
              ce_private.mv_bz_plan_money, ce_private.v_bz_switch, ce_private.mv_bz_late,
              ce_private.sbg_input, ce_private.mv_bz_pairs
  from public, anon, authenticated, service_role;
grant select on ce_private.settings_v2, ce_private.v_bz_paid, ce_private.mv_bz_state,
                ce_private.mv_bz_spells, ce_private.mv_bz_month, ce_private.v_bz_quarters,
                ce_private.mv_bz_plan_money, ce_private.v_bz_switch, ce_private.mv_bz_late,
                ce_private.sbg_input, ce_private.mv_bz_pairs
  to ce_loader;
alter table ce_private.settings_v2 enable row level security;
create policy settings_v2_loader_select on ce_private.settings_v2 for select to ce_loader using (true);
