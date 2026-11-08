-- Customer Equity · migratie 3/4
-- ce_public: de enige laag die de browser kan lezen. Uitsluitend geaggregeerde,
-- vooraf geselecteerde dashboardresultaten van één gepubliceerde run.
--
-- Rechten
--   anon       : alleen SELECT (grant + RLS-policy "for select").
--   ce_loader  : SELECT, INSERT, DELETE (publiceren = alles vervangen in één transactie).
--   overige    : niets. Geen functies in dit schema.
--
-- Publicatie: zie supabase/README.md. In het kort, binnen één transactie als ce_loader:
--   delete from ce_public.dataset_info;   -- cascade naar alle kindtabellen
--   insert dataset_info, segment_month, sensitivity, data_quality;
--   select * from ce_private.publication_checks;   -- moet leeg zijn, anders rollback
--   commit;

-- ---------------------------------------------------------------------------
-- 1. dataset_info: precies één rij met herkomst, licentie en gepubliceerde aannames
-- ---------------------------------------------------------------------------
create table ce_public.dataset_info (
  run_id                 uuid primary key,
  singleton              boolean not null default true unique check (singleton),
  published_at           timestamptz not null default now(),
  reference_date         date not null check (extract(day from reference_date + 1) = 1),
  history_start          date not null check (extract(day from history_start) = 1),
  history_end            date not null,
  currency               text not null check (currency = 'USD'),
  source_name            text not null,
  source_url             text not null,
  source_sha256          text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  license                text not null,
  attribution            text not null,
  data_nature_note       text not null,
  population_note        text not null,
  seed                   bigint not null,
  generator_version      text not null,
  model_version          text not null,
  churn_target           numeric(6,5) not null check (churn_target > 0 and churn_target < 1),
  discount_rate          numeric(6,5) not null check (discount_rate >= 0 and discount_rate < 1),
  horizon_months         integer not null check (horizon_months between 1 and 600),
  results_checksum       text not null check (results_checksum ~ '^[0-9a-f]{64}$'),
  published_assumptions  jsonb not null check (jsonb_typeof(published_assumptions) = 'array'),
  constraint dataset_info_history_range check (history_end = reference_date and history_start < history_end)
);
comment on table ce_public.dataset_info is
  'Eén rij: de gepubliceerde run, bron en licentie, aard van de data (IBM-voorbeeldbron, '
  'gesimuleerde historie) en de vrijgegeven aannames voor "How we calculate".';
comment on column ce_public.dataset_info.published_assumptions is
  'Array van {key, label, value, unit, basis, scenario, contract_type?, tenure_band?}. '
  'Alleen aannames met publish = true in ce_private.financial_assumptions.';

-- ---------------------------------------------------------------------------
-- 2. segment_month: maand x contracttype (36 x 3 rijen)
-- ---------------------------------------------------------------------------
create table ce_public.segment_month (
  run_id                   uuid    not null references ce_public.dataset_info (run_id) on delete cascade,
  period_end               date    not null check (extract(day from period_end + 1) = 1),
  contract_type            text    not null check (contract_type in ('Month-to-month', 'One year', 'Two year')),
  active_start             integer not null check (active_start >= 0),
  new_customers            integer not null check (new_customers >= 0),
  reactivated              integer not null default 0 check (reactivated >= 0),
  churned                  integer not null check (churned >= 0),
  active_end               integer not null check (active_end >= 5),
  expected_churn           numeric(12,4) not null check (expected_churn >= 0),
  revenue                  numeric(14,2) not null check (revenue >= 0),
  variable_cost            numeric(14,2) not null check (variable_cost >= 0),
  contribution_margin      numeric(14,2) generated always as (revenue - variable_cost) stored,
  customer_equity          numeric(16,2) not null,
  active_end_simulated     integer not null,
  new_customers_simulated  integer not null,
  primary key (run_id, period_end, contract_type),
  constraint segment_month_flow_balance
    check (active_end = active_start + new_customers + reactivated - churned),
  constraint segment_month_simulated_active
    check (active_end_simulated between 0 and active_end),
  constraint segment_month_simulated_new
    check (new_customers_simulated between 0 and new_customers)
);
comment on table ce_public.segment_month is
  'Maandelijkse aggregaten per contracttype (USD). Klantstromen, gemodelleerde verwachte churn, '
  'gesimuleerde maandfinanciën en Customer Equity op het maandeinde. Geen klantniveau; '
  'elke rij met bedragen rust op minimaal 5 actieve records.';
comment on column ce_public.segment_month.churned is
  'Aantal vertrekkers in de maand. Vertrekmaanden zijn gesimuleerd met seed en churnmodel.';
comment on column ce_public.segment_month.expected_churn is
  'Som van de gemodelleerde maandelijkse churnkans over de klanten die risico liepen.';
comment on column ce_public.segment_month.customer_equity is
  'Som van CLV (gemodelleerd: marge x overlevingskans x discontering, horizon uit dataset_info) '
  'van de actieve klanten op period_end.';

-- ---------------------------------------------------------------------------
-- 3. sensitivity: Customer Equity op de referentiedatum per scenario
-- ---------------------------------------------------------------------------
create table ce_public.sensitivity (
  run_id           uuid     not null references ce_public.dataset_info (run_id) on delete cascade,
  parameter        text     not null check (parameter in (
                     'churn_level', 'two_year_churn_floor', 'discount_rate', 'horizon_months', 'variable_costs')),
  scenario_label   text     not null check (char_length(scenario_label) between 1 and 60),
  parameter_value  numeric  not null,
  unit             text     not null,
  is_base          boolean  not null,
  customer_equity  numeric(16,2) not null,
  avg_clv          numeric(12,2) not null,
  delta_pct        numeric(9,6)  not null,
  sort_order       smallint not null,
  primary key (run_id, parameter, scenario_label),
  constraint sensitivity_base_zero_delta check (not is_base or delta_pct = 0)
);
create unique index sensitivity_one_base_per_parameter
  on ce_public.sensitivity (run_id, parameter) where is_base;
comment on table ce_public.sensitivity is
  'Gevoeligheid van Customer Equity en gemiddelde CLV op de referentiedatum (USD).';

-- ---------------------------------------------------------------------------
-- 4. data_quality: resultaten van validatie en consistentiecontroles
-- ---------------------------------------------------------------------------
create table ce_public.data_quality (
  run_id        uuid     not null references ce_public.dataset_info (run_id) on delete cascade,
  check_key     text     not null check (check_key ~ '^[a-z0-9_]{1,60}$'),
  category      text     not null check (category in ('source', 'normalisation', 'model', 'simulation', 'publication')),
  status        text     not null check (status in ('pass', 'warn')),
  metric_value  numeric,
  threshold     text,
  description   text     not null,
  sort_order    smallint not null,
  primary key (run_id, check_key)
);
comment on table ce_public.data_quality is
  'Gepubliceerde datakwaliteitscontroles. Een run met een mislukte controle (fail) kan niet '
  'worden gepubliceerd: status kent alleen pass en warn.';

-- ---------------------------------------------------------------------------
-- 5. Rechten en RLS
-- ---------------------------------------------------------------------------
revoke all on all tables in schema ce_public from public, anon, authenticated, service_role;

grant select on ce_public.dataset_info  to anon;
grant select on ce_public.segment_month to anon;
grant select on ce_public.sensitivity   to anon;
grant select on ce_public.data_quality  to anon;

grant select, insert, delete on ce_public.dataset_info  to ce_loader;
grant select, insert, delete on ce_public.segment_month to ce_loader;
grant select, insert, delete on ce_public.sensitivity   to ce_loader;
grant select, insert, delete on ce_public.data_quality  to ce_loader;

alter table ce_public.dataset_info  enable row level security;
alter table ce_public.segment_month enable row level security;
alter table ce_public.sensitivity   enable row level security;
alter table ce_public.data_quality  enable row level security;

-- Publiek lezen
create policy dataset_info_public_read  on ce_public.dataset_info  for select to anon using (true);
create policy segment_month_public_read on ce_public.segment_month for select to anon using (true);
create policy sensitivity_public_read   on ce_public.sensitivity   for select to anon using (true);
create policy data_quality_public_read  on ce_public.data_quality  for select to anon using (true);

-- Publiceren door ce_loader (geen UPDATE: een publicatie vervangt alles)
create policy dataset_info_loader_select  on ce_public.dataset_info  for select to ce_loader using (true);
create policy dataset_info_loader_insert  on ce_public.dataset_info  for insert to ce_loader with check (true);
create policy dataset_info_loader_delete  on ce_public.dataset_info  for delete to ce_loader using (true);
create policy segment_month_loader_select on ce_public.segment_month for select to ce_loader using (true);
create policy segment_month_loader_insert on ce_public.segment_month for insert to ce_loader with check (true);
create policy segment_month_loader_delete on ce_public.segment_month for delete to ce_loader using (true);
create policy sensitivity_loader_select   on ce_public.sensitivity   for select to ce_loader using (true);
create policy sensitivity_loader_insert   on ce_public.sensitivity   for insert to ce_loader with check (true);
create policy sensitivity_loader_delete   on ce_public.sensitivity   for delete to ce_loader using (true);
create policy data_quality_loader_select  on ce_public.data_quality  for select to ce_loader using (true);
create policy data_quality_loader_insert  on ce_public.data_quality  for insert to ce_loader with check (true);
create policy data_quality_loader_delete  on ce_public.data_quality  for delete to ce_loader using (true);

-- ---------------------------------------------------------------------------
-- 6. Publicatiecontroles (in ce_private, alleen voor ce_loader)
-- ---------------------------------------------------------------------------
-- Moet leeg zijn voordat de publicatietransactie wordt gecommit.
create view ce_private.publication_checks
with (security_invoker = true) as
with info as (
  select d.run_id,
         d.history_start,
         d.history_end,
         ( (extract(year from d.history_end) - extract(year from d.history_start)) * 12
         + extract(month from d.history_end) - extract(month from d.history_start) + 1 )::int as months
  from ce_public.dataset_info d
),
sm as (
  select s.contract_type,
         s.period_end,
         s.active_start,
         lag(s.active_end) over w as prev_active_end,
         lag(s.period_end) over w as prev_period_end
  from ce_public.segment_month s
  window w as (partition by s.contract_type order by s.period_end)
)
select 'dataset_info_exactly_one_row'::text as check_name,
       format('aantal rijen: %s', (select count(*) from ce_public.dataset_info)) as detail
where (select count(*) from ce_public.dataset_info) <> 1

union all
select 'segment_month_rows_per_contract',
       format('%s: verwacht %s maanden, gevonden %s', c.contract_type, i.months, coalesce(n.cnt, 0))
from info i
cross join (values ('Month-to-month'), ('One year'), ('Two year')) as c (contract_type)
left join (select contract_type, count(*) as cnt from ce_public.segment_month group by contract_type) n
  on n.contract_type = c.contract_type
where coalesce(n.cnt, 0) <> i.months

union all
select 'segment_month_outside_history',
       format('%s %s', s.contract_type, s.period_end)
from ce_public.segment_month s
cross join info i
where s.period_end < i.history_start or s.period_end > i.history_end

union all
select 'segment_month_gap',
       format('%s: %s volgt op %s', sm.contract_type, sm.period_end, sm.prev_period_end)
from sm
where sm.prev_period_end is not null
  and sm.period_end <> ((sm.prev_period_end + 1) + interval '1 month' - interval '1 day')::date

union all
select 'segment_month_continuity',
       format('%s %s: active_start %s <> vorige active_end %s',
              sm.contract_type, sm.period_end, sm.active_start, sm.prev_active_end)
from sm
where sm.prev_active_end is not null
  and sm.active_start <> sm.prev_active_end

union all
select 'sensitivity_base_missing',
       format('parameter %s heeft geen basisrij', p.parameter)
from (select distinct parameter from ce_public.sensitivity) p
where not exists (
  select 1 from ce_public.sensitivity s where s.parameter = p.parameter and s.is_base
)

union all
select 'data_quality_empty', 'geen datakwaliteitscontroles gepubliceerd'
where exists (select 1 from ce_public.dataset_info)
  and not exists (select 1 from ce_public.data_quality);

comment on view ce_private.publication_checks is
  'Consistentiecontroles op de te publiceren data. Elke rij is een overtreding.';

revoke all on ce_private.publication_checks from public, anon, authenticated, service_role;
grant select on ce_private.publication_checks to ce_loader;
