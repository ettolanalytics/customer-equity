-- Customer Equity · migratie 6
-- Ruwe data van de Beanrise-API (datacontract v1.2) en de registratie van ladingen.
-- Ontwerp: docs/ontwerp-dashboard-v3.md §2 (lokaal). Geschreven door
-- scripts/ingest_beanrise.py (als ce_loader), alles-of-niets per lading.
--
-- Raakt niets bestaands: ce_public, de oude facturen (ce_private.invoices), de views en
-- refresh_and_publish() blijven ongewijzigd.
--
-- Compact opgeslagen (opslaggrens 500 MB): integer-ids, datums voor perioden, codes als
-- smallint, geen ruwe JSON, geen secundaire indexen, geen kolommen die niet gebruikt of
-- gecontroleerd worden (vat_cents, currency en issued_at worden bij het laden gecontroleerd
-- en niet bewaard).

-- ---------------------------------------------------------------------------
-- 1. Abonnementen en kostprijzen (klein; elke lading volledig vervangen)
-- ---------------------------------------------------------------------------
create table ce_private.bz_plans (
  plan_id               smallint     not null check (plan_id > 0),
  valid_from            date         not null,
  valid_to              date,
  name                  text         not null,
  size_grams            integer      not null check (size_grams > 0),
  billing_interval      text         not null,
  price_excl_vat_cents  integer      not null check (price_excl_vat_cents >= 0),
  vat_rate              numeric(5,4) not null,
  primary key (plan_id, valid_from),
  check (valid_to is null or valid_to > valid_from)
);
comment on table ce_private.bz_plans is 'Beanrise /v1/plans. Elke lading volledig vervangen.';

create table ce_private.bz_product_costs (
  plan_id     smallint not null check (plan_id > 0),
  valid_from  date     not null,
  valid_to    date,
  cost_cents  integer  not null check (cost_cents >= 0),
  primary key (plan_id, valid_from),
  check (valid_to is null or valid_to > valid_from)
);
comment on table ce_private.bz_product_costs is 'Beanrise /v1/product-costs. Elke lading volledig vervangen.';

-- ---------------------------------------------------------------------------
-- 2. Klanten en abonnementen (veranderen; bijgewerkt via updated_since)
-- ---------------------------------------------------------------------------
create table ce_private.bz_customers (
  customer_id  integer     primary key check (customer_id > 0),
  created_at   timestamptz not null,
  updated_at   timestamptz not null
);
comment on table ce_private.bz_customers is
  'Beanrise /v1/customers: alleen id en tijden, geen persoonsgegevens.';

create table ce_private.bz_subscriptions (
  subscription_id  integer     primary key check (subscription_id > 0),
  customer_id      integer     not null check (customer_id > 0),
  plan_id          smallint    not null check (plan_id > 0),
  status           smallint    not null check (status in (1, 2, 3)),
  billing_day      smallint    not null check (billing_day between 1 and 31),
  started_at       timestamptz not null,
  canceled_at      timestamptz,
  updated_at       timestamptz not null
);
comment on table ce_private.bz_subscriptions is
  'Beanrise /v1/subscriptions. status: 1 = active, 2 = past_due, 3 = canceled.';

-- ---------------------------------------------------------------------------
-- 3. Events en facturen (veranderen nooit; alleen invoegen, via after_id)
-- ---------------------------------------------------------------------------
create table ce_private.bz_subscription_events (
  event_id         integer     primary key check (event_id > 0),
  subscription_id  integer     not null check (subscription_id > 0),
  type             smallint    not null check (type in (1, 2, 3)),
  from_plan_id     smallint,
  to_plan_id       smallint,
  occurred_at      timestamptz not null,
  created_at       timestamptz not null
);
comment on table ce_private.bz_subscription_events is
  'Beanrise /v1/subscription-events. type: 1 = created, 2 = plan_changed, 3 = canceled.';

-- Kolomvolgorde bewust: eerst 8 bytes, dan 4, dan 2 (geen opvulruimte).
create table ce_private.bz_invoices (
  paid_at                timestamptz,
  invoice_id             integer  primary key check (invoice_id > 0),
  subscription_id        integer  not null check (subscription_id > 0),
  customer_id            integer  not null check (customer_id > 0),
  amount_excl_vat_cents  integer  not null check (amount_excl_vat_cents >= 0),
  period_start           date     not null,
  period_end             date     not null,
  plan_id                smallint not null check (plan_id > 0),
  status                 smallint not null check (status in (1, 2)),
  check (period_end > period_start),
  check ((status = 1) = (paid_at is not null))
);
comment on table ce_private.bz_invoices is
  'Beanrise /v1/invoices. status: 1 = paid, 2 = failed. Elke betaalpoging is een eigen rij. '
  'period_end is exclusief. Bedragen in centen excl. btw.';

-- ---------------------------------------------------------------------------
-- 4. Registratie van ladingen
-- ---------------------------------------------------------------------------
create table ce_private.loads (
  load_id      bigint generated always as identity primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default clock_timestamp(),
  status       text        not null check (status in ('complete', 'failed')),
  as_of        date,
  endpoints    jsonb       not null default '{}'::jsonb,
  checks       jsonb       not null default '[]'::jsonb,
  db_bytes     bigint,
  error        text,
  git_sha      text,
  run_id       text
);
comment on table ce_private.loads is
  'Eén rij per lading uit de Beanrise-API: as_of, per endpoint watermerken, aantallen, '
  'bytes en sha256, de controles en de omvang van de database. Watermerken komen uit de '
  'laatste rij met status complete. error bevat nooit URL, sleutel of antwoordtekst.';

-- ---------------------------------------------------------------------------
-- 5. Rechten en RLS: alleen ce_loader
-- ---------------------------------------------------------------------------
revoke all on ce_private.bz_plans, ce_private.bz_product_costs, ce_private.bz_customers,
              ce_private.bz_subscriptions, ce_private.bz_subscription_events,
              ce_private.bz_invoices, ce_private.loads
  from public, anon, authenticated, service_role;

grant select, insert, delete on ce_private.bz_plans, ce_private.bz_product_costs to ce_loader;
grant select, insert, update on ce_private.bz_customers, ce_private.bz_subscriptions to ce_loader;
grant select, insert         on ce_private.bz_subscription_events, ce_private.bz_invoices,
                                ce_private.loads to ce_loader;

alter table ce_private.bz_plans               enable row level security;
alter table ce_private.bz_product_costs       enable row level security;
alter table ce_private.bz_customers           enable row level security;
alter table ce_private.bz_subscriptions       enable row level security;
alter table ce_private.bz_subscription_events enable row level security;
alter table ce_private.bz_invoices            enable row level security;
alter table ce_private.loads                  enable row level security;

create policy bz_plans_loader_select   on ce_private.bz_plans for select to ce_loader using (true);
create policy bz_plans_loader_insert   on ce_private.bz_plans for insert to ce_loader with check (true);
create policy bz_plans_loader_delete   on ce_private.bz_plans for delete to ce_loader using (true);
create policy bz_costs_loader_select   on ce_private.bz_product_costs for select to ce_loader using (true);
create policy bz_costs_loader_insert   on ce_private.bz_product_costs for insert to ce_loader with check (true);
create policy bz_costs_loader_delete   on ce_private.bz_product_costs for delete to ce_loader using (true);
create policy bz_customers_loader_select on ce_private.bz_customers for select to ce_loader using (true);
create policy bz_customers_loader_insert on ce_private.bz_customers for insert to ce_loader with check (true);
create policy bz_customers_loader_update on ce_private.bz_customers for update to ce_loader using (true) with check (true);
create policy bz_subs_loader_select    on ce_private.bz_subscriptions for select to ce_loader using (true);
create policy bz_subs_loader_insert    on ce_private.bz_subscriptions for insert to ce_loader with check (true);
create policy bz_subs_loader_update    on ce_private.bz_subscriptions for update to ce_loader using (true) with check (true);
create policy bz_events_loader_select  on ce_private.bz_subscription_events for select to ce_loader using (true);
create policy bz_events_loader_insert  on ce_private.bz_subscription_events for insert to ce_loader with check (true);
create policy bz_invoices_loader_select on ce_private.bz_invoices for select to ce_loader using (true);
create policy bz_invoices_loader_insert on ce_private.bz_invoices for insert to ce_loader with check (true);
create policy loads_loader_select      on ce_private.loads for select to ce_loader using (true);
create policy loads_loader_insert      on ce_private.loads for insert to ce_loader with check (true);
