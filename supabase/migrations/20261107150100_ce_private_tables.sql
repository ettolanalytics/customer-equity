-- Customer Equity · migratie 2/5
-- ce_private: ruwe facturen, generatorruns, aannames en refreshlog.
-- Niet blootgesteld aan de Data API. RLS aan op elke tabel; alleen ce_loader
-- heeft policies. Geen rechten voor anon, authenticated, service_role of PUBLIC.

-- ---------------------------------------------------------------------------
-- 1. Generatorruns (herkomst van de geladen facturen)
-- ---------------------------------------------------------------------------
create table ce_private.generator_runs (
  id                 bigint generated always as identity primary key,
  company            text        not null,
  generator_version  text        not null,
  seed               bigint      not null,
  parameters         jsonb       not null check (jsonb_typeof(parameters) = 'object'),
  rows               integer     not null check (rows > 0),
  customers          integer     not null check (customers > 0),
  invoices_sha256    text        not null check (invoices_sha256 ~ '^[0-9a-f]{64}$'),
  loaded_at          timestamptz not null default now()
);
comment on table ce_private.generator_runs is
  'Eén rij per laadactie: seed, versie, parameters en SHA-256 van het Parquet-bestand '
  '(scripts/generate_beanrise.py). De laatste rij hoort bij de facturen in invoices.';

-- ---------------------------------------------------------------------------
-- 2. Facturen (ruwe data): één rij per betaalde maand
-- ---------------------------------------------------------------------------
create table ce_private.invoices (
  customer_id   integer      not null check (customer_id > 0),
  invoice_date  date         not null,
  expire_date   date         not null,
  amount_eur    numeric(5,2) not null check (amount_eur > 0),
  primary key (customer_id, invoice_date),
  constraint invoices_expire_after_invoice check (expire_date > invoice_date)
);
comment on table ce_private.invoices is
  'Beanrise Coffee (fictief): één factuur per maand per klant. expire_date = einde van de '
  'betaalde maand. Geen opzeggingen of pauzes: churn = geen volgende factuur.';

-- ---------------------------------------------------------------------------
-- 3. Vaste aannames en rekenperiode (één rij)
-- ---------------------------------------------------------------------------
create table ce_private.settings (
  id                        smallint primary key default 1 check (id = 1),
  price_eur                 numeric(6,2)     not null,
  cost_per_invoice_eur      numeric(6,2)     not null,
  discount_rate_year        double precision not null check (discount_rate_year > 0 and discount_rate_year < 1),
  horizon_quarters          integer          not null check (horizon_quarters between 1 and 200),
  grace_days                integer          not null check (grace_days >= 0),
  first_calc_quarter        date             not null check (extract(day from first_calc_quarter) = 1
                                                            and extract(month from first_calc_quarter) in (1, 4, 7, 10)),
  first_dashboard_quarter   date             not null check (extract(day from first_dashboard_quarter) = 1
                                                            and extract(month from first_dashboard_quarter) in (1, 4, 7, 10)),
  last_quarter              date             not null check (extract(day from last_quarter) = 1
                                                            and extract(month from last_quarter) in (1, 4, 7, 10)),
  constraint settings_order check (first_calc_quarter <= first_dashboard_quarter
                                   and first_dashboard_quarter <= last_quarter)
);
comment on table ce_private.settings is
  'Vaste aannames (CLAUDE.md) en de rekenperiode. Kwartalen als eerste dag van het kwartaal. '
  'first_calc_quarter: begin van de historie (CLV-retentie, verwachte churn); '
  'first_dashboard_quarter: eerste kwartaal in ce_public.quarters.';

insert into ce_private.settings
  (price_eur, cost_per_invoice_eur, discount_rate_year, horizon_quarters, grace_days,
   first_calc_quarter, first_dashboard_quarter, last_quarter)
values
  (24.95, 14.00, 0.10, 20, 30, date '2019-01-01', date '2020-01-01', date '2026-07-01');

-- ---------------------------------------------------------------------------
-- 4. Refreshlog
-- ---------------------------------------------------------------------------
create table ce_private.refresh_log (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default clock_timestamp(),
  status       text        not null check (status in ('published', 'failed')),
  message      text,
  details      jsonb
);
comment on table ce_private.refresh_log is
  'Eén rij per aanroep van ce_private.refresh_and_publish(). Bij failed staan de mislukte '
  'controles in details; ce_public is dan niet gewijzigd.';

-- ---------------------------------------------------------------------------
-- 5. Rechten en RLS
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema ce_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema ce_private from public, anon, authenticated, service_role;

-- Herladen: TRUNCATE in plaats van DELETE, zodat er geen 2 miljoen dode rijen
-- achterblijven (de opslaggrens is 500 MB).
grant select, insert, truncate on ce_private.invoices       to ce_loader;
grant select, insert          on ce_private.generator_runs to ce_loader;
grant select                  on ce_private.settings       to ce_loader;
grant select                  on ce_private.refresh_log    to ce_loader;

alter table ce_private.invoices       enable row level security;
alter table ce_private.generator_runs enable row level security;
alter table ce_private.settings       enable row level security;
alter table ce_private.refresh_log    enable row level security;

create policy invoices_loader_select       on ce_private.invoices       for select to ce_loader using (true);
create policy invoices_loader_insert       on ce_private.invoices       for insert to ce_loader with check (true);
create policy generator_runs_loader_select on ce_private.generator_runs for select to ce_loader using (true);
create policy generator_runs_loader_insert on ce_private.generator_runs for insert to ce_loader with check (true);
create policy settings_loader_select       on ce_private.settings       for select to ce_loader using (true);
create policy refresh_log_loader_select    on ce_private.refresh_log    for select to ce_loader using (true);
