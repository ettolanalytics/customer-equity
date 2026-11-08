-- Customer Equity · migratie 2/4
-- ce_private: brondata, genormaliseerde en gesimuleerde data, aannames, runs.
-- Niet blootgesteld aan de Data API. RLS aan op elke tabel; alleen ce_loader
-- heeft policies. Geen rechten voor anon, authenticated, service_role of PUBLIC.
--
-- Vereist PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT).
--
-- Datumconventies
--   * Maanden worden opgeslagen als de eerste dag van de maand (start_month, end_month).
--   * start_month  = maand waarin het abonnement begon.
--   * end_month    = maand waarin de klant vertrok (gesimuleerd); null = actief op de referentiedatum.
--   * Financiële maanden lopen van start_month + 1 t/m end_month (of de referentiemaand),
--     zodat het aantal gefactureerde maanden gelijk is aan IBM-tenure (tenure 0 = nog niets gefactureerd).

-- ---------------------------------------------------------------------------
-- 1. Importbatches (metadata per gedownload bronbestand)
-- ---------------------------------------------------------------------------
create table ce_private.import_batches (
  id                 uuid primary key default gen_random_uuid(),
  source_name        text        not null,
  source_url         text        not null,
  source_sha256      text        not null unique check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes       bigint      not null check (source_bytes > 0),
  row_count          integer     not null check (row_count > 0),
  license            text        not null,
  attribution        text        not null,
  retrieved_at       timestamptz not null,
  imported_at        timestamptz not null default now(),
  validation_report  jsonb       not null check (jsonb_typeof(validation_report) = 'object')
);
comment on table ce_private.import_batches is
  'Eén rij per geïmporteerd bronbestand. Dezelfde SHA-256 kan maar één keer worden geïmporteerd.';

-- ---------------------------------------------------------------------------
-- 2. IBM-brondata, ongewijzigd als tekst
-- ---------------------------------------------------------------------------
create table ce_private.raw_ibm_telco (
  import_batch_id    uuid    not null references ce_private.import_batches (id) on delete cascade,
  source_row_number  integer not null check (source_row_number >= 1),
  "customerID"       text not null,
  "gender"           text not null,
  "SeniorCitizen"    text not null,
  "Partner"          text not null,
  "Dependents"       text not null,
  "tenure"           text not null,
  "PhoneService"     text not null,
  "MultipleLines"    text not null,
  "InternetService"  text not null,
  "OnlineSecurity"   text not null,
  "OnlineBackup"     text not null,
  "DeviceProtection" text not null,
  "TechSupport"      text not null,
  "StreamingTV"      text not null,
  "StreamingMovies"  text not null,
  "Contract"         text not null,
  "PaperlessBilling" text not null,
  "PaymentMethod"    text not null,
  "MonthlyCharges"   text not null,
  "TotalCharges"     text not null,
  "Churn"            text not null,
  primary key (import_batch_id, "customerID"),
  unique (import_batch_id, source_row_number)
);
comment on table ce_private.raw_ibm_telco is
  'IBM Telco Customer Churn (Apache-2.0), kolomnamen en waarden exact zoals in de CSV. '
  'Wordt nooit bijgewerkt: ce_loader heeft geen UPDATE-recht.';

-- ---------------------------------------------------------------------------
-- 3. Runs (simulatie + berekening + publicatie)
-- ---------------------------------------------------------------------------
create table ce_private.simulation_runs (
  id                        uuid primary key default gen_random_uuid(),
  import_batch_id           uuid        not null references ce_private.import_batches (id) on delete restrict,
  assumption_set            text        not null check (assumption_set ~ '^[a-z0-9_.-]{1,40}$'),
  reference_date            date        not null check (extract(day from reference_date + 1) = 1),
  window_months             integer     not null check (window_months between 1 and 120),
  seed                      bigint      not null,
  rng_algorithm             text        not null default 'mulberry32',
  generator_version         text        not null,
  model_version             text        not null,
  churn_target              numeric(6,5) not null check (churn_target > 0 and churn_target < 1),
  input_checksum            text        not null check (input_checksum ~ '^[0-9a-f]{64}$'),
  customer_values_checksum  text        check (customer_values_checksum ~ '^[0-9a-f]{64}$'),
  results_checksum          text        check (results_checksum ~ '^[0-9a-f]{64}$'),
  results_summary           jsonb       check (results_summary is null or jsonb_typeof(results_summary) = 'object'),
  status                    text        not null default 'generated'
                            check (status in ('generated', 'validated', 'published', 'failed')),
  created_at                timestamptz not null default now(),
  published_at              timestamptz,
  constraint simulation_runs_published_at check ((status = 'published') = (published_at is not null)),
  constraint simulation_runs_checksums_when_validated check (
    status in ('generated', 'failed')
    or (customer_values_checksum is not null and results_checksum is not null and results_summary is not null)
  )
);
comment on table ce_private.simulation_runs is
  'Reproduceerbaarheid: seed, generator- en modelversie, aannameset en controlesommen. '
  'Individuele klant-maandwaarden worden in v1 niet opgeslagen; customer_values_checksum '
  'is de SHA-256 over hun deterministische serialisatie.';

-- ---------------------------------------------------------------------------
-- 4. Klanten (IBM of gesimuleerd)
-- ---------------------------------------------------------------------------
create table ce_private.customers (
  id                           uuid primary key default gen_random_uuid(),
  record_origin                text not null check (record_origin in ('ibm', 'simulated')),
  import_batch_id              uuid references ce_private.import_batches (id) on delete restrict,
  source_customer_id           text check (source_customer_id ~ '^[0-9]{4}-[A-Z]{5}$'),
  simulation_run_id            uuid references ce_private.simulation_runs (id) on delete cascade,
  simulated_code               text check (simulated_code ~ '^SIM-[0-9]{6}$'),
  template_source_customer_id  text check (template_source_customer_id ~ '^[0-9]{4}-[A-Z]{5}$'),
  gender                       text check (gender in ('Female', 'Male')),
  senior_citizen               boolean,
  partner                      boolean,
  dependents                   boolean,
  created_at                   timestamptz not null default now(),
  constraint customers_origin_consistency check (
    (record_origin = 'ibm'
      and import_batch_id is not null and source_customer_id is not null
      and simulation_run_id is null and simulated_code is null and template_source_customer_id is null
      and gender is not null and senior_citizen is not null and partner is not null and dependents is not null)
    or
    (record_origin = 'simulated'
      and source_customer_id is null
      and simulation_run_id is not null and simulated_code is not null and template_source_customer_id is not null)
  ),
  unique (import_batch_id, source_customer_id),
  unique (simulation_run_id, simulated_code)
);
comment on column ce_private.customers.id is 'Interne klant-ID. Nooit gelijk aan of afgeleid van het IBM-ID.';
comment on column ce_private.customers.source_customer_id is 'Oorspronkelijk IBM customerID; alleen voor record_origin = ibm.';
comment on column ce_private.customers.template_source_customer_id is
  'IBM-record waarvan profiel en tarief zijn overgenomen; alleen voor gesimuleerde klanten.';

-- ---------------------------------------------------------------------------
-- 5. Abonnementen (tijdlijn per run)
-- ---------------------------------------------------------------------------
create table ce_private.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  simulation_run_id         uuid     not null references ce_private.simulation_runs (id) on delete cascade,
  customer_id               uuid     not null references ce_private.customers (id) on delete cascade,
  subscription_seq          smallint not null default 1 check (subscription_seq >= 1),
  previous_subscription_id  uuid     references ce_private.subscriptions (id) on delete set null,

  contract_type             text     not null check (contract_type in ('Month-to-month', 'One year', 'Two year')),
  phone_service             boolean  not null,
  multiple_lines            boolean,
  internet_service          text     not null check (internet_service in ('DSL', 'Fiber optic', 'None')),
  online_security           boolean,
  online_backup             boolean,
  device_protection         boolean,
  tech_support              boolean,
  streaming_tv              boolean,
  streaming_movies          boolean,
  paperless_billing         boolean  not null,
  payment_method            text     not null check (payment_method in (
                              'Electronic check', 'Mailed check',
                              'Bank transfer (automatic)', 'Credit card (automatic)')),
  monthly_charges           numeric(8,2) not null check (monthly_charges > 0),

  -- Oorspronkelijke IBM-waarden (null voor gesimuleerde klanten)
  ibm_tenure_months         integer       check (ibm_tenure_months >= 0),
  ibm_total_charges         numeric(10,2) check (ibm_total_charges >= 0),
  ibm_total_charges_note    text,
  ibm_churn_flag            boolean,

  -- Tijdlijn
  start_month               date not null check (extract(day from start_month) = 1),
  start_month_basis         text not null check (start_month_basis in (
                              'derived_from_tenure',
                              'derived_from_tenure_and_simulated_end',
                              'simulated')),
  end_month                 date check (end_month is null or extract(day from end_month) = 1),
  end_month_basis           text check (end_month_basis in ('simulated')),
  status_at_reference       text not null check (status_at_reference in ('active', 'churned')),
  created_at                timestamptz not null default now(),

  constraint subscriptions_end_consistency check (
    (end_month is null) = (status_at_reference = 'active')
    and (end_month is null) = (end_month_basis is null)
  ),
  constraint subscriptions_end_after_start check (end_month is null or end_month > start_month),
  constraint subscriptions_phone_lines check (phone_service = (multiple_lines is not null)),
  constraint subscriptions_internet_addons check (
    (internet_service = 'None'
      and online_security is null and online_backup is null and device_protection is null
      and tech_support is null and streaming_tv is null and streaming_movies is null)
    or
    (internet_service <> 'None'
      and online_security is not null and online_backup is not null and device_protection is not null
      and tech_support is not null and streaming_tv is not null and streaming_movies is not null)
  ),
  constraint subscriptions_reactivation_link check ((subscription_seq = 1) = (previous_subscription_id is null)),
  unique (simulation_run_id, customer_id, subscription_seq)
);
create index subscriptions_run_idx on ce_private.subscriptions (simulation_run_id);
create index subscriptions_customer_idx on ce_private.subscriptions (customer_id);
comment on table ce_private.subscriptions is
  'Abonnementstijdlijn per run. Vertrekmaanden zijn altijd gesimuleerd (end_month_basis). '
  'IBM-churnrecords zijn bronprofielen, geen bewijs voor een historische vertrekmaand. '
  'previous_subscription_id is voorbereid op heractivaties (v1: altijd null).';
comment on column ce_private.subscriptions.monthly_charges is
  'Huidig maandtarief (USD). Vereenvoudiging: gebruikt als vast tarief voor reconstructie en prognose.';
comment on column ce_private.subscriptions.ibm_total_charges is
  'IBM TotalCharges als bronwaarde. Alleen voor datakwaliteitssignalering, niet als factuurhistorie.';

-- ---------------------------------------------------------------------------
-- 6. Financiële en modelmatige aannames
-- ---------------------------------------------------------------------------
create table ce_private.financial_assumptions (
  id               uuid primary key default gen_random_uuid(),
  assumption_set   text    not null check (assumption_set ~ '^[a-z0-9_.-]{1,40}$'),
  scenario         text    not null default 'base' check (scenario ~ '^[a-z0-9_]{1,40}$'),
  key              text    not null check (key ~ '^[a-z0-9_]{1,60}$'),
  contract_type    text    check (contract_type in ('Month-to-month', 'One year', 'Two year')),
  tenure_band_min  integer check (tenure_band_min >= 0),
  tenure_band_max  integer,
  value            numeric not null,
  unit             text    not null,
  basis            text    not null check (basis in ('assumption', 'derived_ibm', 'modelled')),
  publish          boolean not null default false,
  description      text    not null,
  created_at       timestamptz not null default now(),
  constraint financial_assumptions_band_order check (tenure_band_max is null or tenure_band_max >= tenure_band_min),
  constraint financial_assumptions_band_needs_min check (tenure_band_min is not null or tenure_band_max is null),
  constraint financial_assumptions_band_needs_contract check (tenure_band_min is null or contract_type is not null),
  constraint financial_assumptions_unique
    unique nulls not distinct (assumption_set, scenario, key, contract_type, tenure_band_min)
);
comment on table ce_private.financial_assumptions is
  'Alle expliciete aannames (kosten, discontering, horizon, churnniveau, ondergrens) en '
  'gemodelleerde parameters (churnkans per contract x tenureband). basis maakt het onderscheid '
  'tussen aanname, afgeleid uit IBM en gemodelleerd. publish = opnemen in ce_public.dataset_info.';

-- ---------------------------------------------------------------------------
-- 7. Views
-- ---------------------------------------------------------------------------
-- Vereiste aannames voor de maandfinanciën en het model (scenario base, zonder segment).
create view ce_private.missing_assumptions
with (security_invoker = true) as
select r.assumption_set, k.key
from (select distinct assumption_set from ce_private.simulation_runs) as r
cross join (values
  ('cost_phone_line'), ('cost_internet_dsl'), ('cost_internet_fiber'),
  ('cost_addon_basic'), ('cost_streaming'), ('cost_customer_care'), ('cost_paper_bill'),
  ('cost_payment_electronic_check'), ('cost_payment_mailed_check'), ('cost_payment_bank_transfer'),
  ('pct_payment_credit_card'), ('pct_bad_debt'),
  ('discount_rate_annual'), ('horizon_months'), ('churn_target_monthly'), ('two_year_churn_floor_monthly')
) as k (key)
where not exists (
  select 1
  from ce_private.financial_assumptions a
  where a.assumption_set = r.assumption_set
    and a.scenario = 'base'
    and a.key = k.key
    and a.contract_type is null
);
comment on view ce_private.missing_assumptions is 'Moet leeg zijn voordat een run wordt berekend.';

-- Gesimuleerde maandfinanciën per abonnement (vast tarief + kostenaannames, scenario base).
create view ce_private.subscription_monthly_financials
with (security_invoker = true) as
with run as (
  select r.id                                         as simulation_run_id,
         r.assumption_set,
         date_trunc('month', r.reference_date::timestamp)::date as reference_month,
         (date_trunc('month', r.reference_date::timestamp)
           - make_interval(months => r.window_months - 1))::date as window_start
  from ce_private.simulation_runs r
),
a as (
  select assumption_set,
         max(value) filter (where key = 'cost_phone_line')               as cost_phone_line,
         max(value) filter (where key = 'cost_internet_dsl')             as cost_internet_dsl,
         max(value) filter (where key = 'cost_internet_fiber')           as cost_internet_fiber,
         max(value) filter (where key = 'cost_addon_basic')              as cost_addon_basic,
         max(value) filter (where key = 'cost_streaming')                as cost_streaming,
         max(value) filter (where key = 'cost_customer_care')            as cost_customer_care,
         max(value) filter (where key = 'cost_paper_bill')               as cost_paper_bill,
         max(value) filter (where key = 'cost_payment_electronic_check') as cost_payment_electronic_check,
         max(value) filter (where key = 'cost_payment_mailed_check')     as cost_payment_mailed_check,
         max(value) filter (where key = 'cost_payment_bank_transfer')    as cost_payment_bank_transfer,
         max(value) filter (where key = 'pct_payment_credit_card')       as pct_payment_credit_card,
         max(value) filter (where key = 'pct_bad_debt')                  as pct_bad_debt
  from ce_private.financial_assumptions
  where scenario = 'base' and contract_type is null
  group by assumption_set
),
lines as (
  select s.simulation_run_id,
         s.id            as subscription_id,
         s.contract_type,
         m.month::date   as month,
         s.monthly_charges as revenue,
         ( case when s.phone_service then a.cost_phone_line else 0 end
         + case s.internet_service
             when 'DSL'         then a.cost_internet_dsl
             when 'Fiber optic' then a.cost_internet_fiber
             else 0 end
         + a.cost_addon_basic * ( coalesce(s.online_security, false)::int
                                + coalesce(s.online_backup, false)::int
                                + coalesce(s.device_protection, false)::int
                                + coalesce(s.tech_support, false)::int )
         + a.cost_streaming   * ( coalesce(s.streaming_tv, false)::int
                                + coalesce(s.streaming_movies, false)::int )
         + a.cost_customer_care
         + case when s.paperless_billing then 0 else a.cost_paper_bill end
         + case s.payment_method
             when 'Electronic check'          then a.cost_payment_electronic_check
             when 'Mailed check'              then a.cost_payment_mailed_check
             when 'Bank transfer (automatic)' then a.cost_payment_bank_transfer
             else 0 end
         + case when s.payment_method = 'Credit card (automatic)'
                then a.pct_payment_credit_card * s.monthly_charges else 0 end
         + a.pct_bad_debt * s.monthly_charges
         ) as variable_cost
  from ce_private.subscriptions s
  join run on run.simulation_run_id = s.simulation_run_id
  join a   on a.assumption_set = run.assumption_set
  cross join lateral generate_series(
    greatest((s.start_month + interval '1 month')::date, run.window_start)::timestamp,
    coalesce(s.end_month, run.reference_month)::timestamp,
    interval '1 month'
  ) as m (month)
)
select simulation_run_id,
       subscription_id,
       contract_type,
       month,
       revenue,
       variable_cost,
       revenue - variable_cost       as contribution_margin,
       'simulated_constant_price'::text as basis
from lines;
comment on view ce_private.subscription_monthly_financials is
  'Gesimuleerde maandelijkse omzet, variabele kosten en contributiemarge (USD) binnen het '
  'historische venster. Geen factuurhistorie: vast huidig tarief en fictieve kostenaannames.';

-- ---------------------------------------------------------------------------
-- 8. Rechten en RLS
-- ---------------------------------------------------------------------------
revoke all on all tables in schema ce_private from public, anon, authenticated, service_role;

-- Bron en importmetadata: geen UPDATE (bron blijft ongewijzigd).
grant select, insert, delete on ce_private.import_batches to ce_loader;
grant select, insert, delete on ce_private.raw_ibm_telco  to ce_loader;

grant select, insert, update, delete on ce_private.simulation_runs       to ce_loader;
grant select, insert, update, delete on ce_private.customers             to ce_loader;
grant select, insert, update, delete on ce_private.subscriptions         to ce_loader;
grant select, insert, update, delete on ce_private.financial_assumptions to ce_loader;

grant select on ce_private.missing_assumptions             to ce_loader;
grant select on ce_private.subscription_monthly_financials to ce_loader;

alter table ce_private.import_batches        enable row level security;
alter table ce_private.raw_ibm_telco         enable row level security;
alter table ce_private.simulation_runs       enable row level security;
alter table ce_private.customers             enable row level security;
alter table ce_private.subscriptions         enable row level security;
alter table ce_private.financial_assumptions enable row level security;

-- Alleen ce_loader krijgt policies. Andere rollen: geen policy = geen rijen.
create policy import_batches_loader_select on ce_private.import_batches for select to ce_loader using (true);
create policy import_batches_loader_insert on ce_private.import_batches for insert to ce_loader with check (true);
create policy import_batches_loader_delete on ce_private.import_batches for delete to ce_loader using (true);

create policy raw_ibm_telco_loader_select on ce_private.raw_ibm_telco for select to ce_loader using (true);
create policy raw_ibm_telco_loader_insert on ce_private.raw_ibm_telco for insert to ce_loader with check (true);
create policy raw_ibm_telco_loader_delete on ce_private.raw_ibm_telco for delete to ce_loader using (true);

create policy simulation_runs_loader_all on ce_private.simulation_runs
  for all to ce_loader using (true) with check (true);
create policy customers_loader_all on ce_private.customers
  for all to ce_loader using (true) with check (true);
create policy subscriptions_loader_all on ce_private.subscriptions
  for all to ce_loader using (true) with check (true);
create policy financial_assumptions_loader_all on ce_private.financial_assumptions
  for all to ce_loader using (true) with check (true);
