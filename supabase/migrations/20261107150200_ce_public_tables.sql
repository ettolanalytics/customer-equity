-- Customer Equity · migratie 3/5
-- ce_public: alleen geaggregeerde kwartaalcijfers en de aannames die het scherm
-- in zijn zinnen gebruikt. Blootgesteld aan de Data API (Exposed schemas).
--   anon       : alleen SELECT (grant + RLS-policy "for select").
--   ce_loader  : alleen SELECT (ter controle). Schrijven gebeurt uitsluitend door
--                ce_private.refresh_and_publish() (security definer, eigenaar postgres).
-- Geen rij beschrijft een individuele klant.

-- ---------------------------------------------------------------------------
-- 1. Kwartaalcijfers: één rij per kwartaal, data = het object uit src/lib/quarters.ts
-- ---------------------------------------------------------------------------
create table ce_public.quarters (
  seq    integer primary key check (seq >= 1),
  label  text    not null unique check (label ~ '^Q[1-4] [0-9]{4}$'),
  data   jsonb   not null check (jsonb_typeof(data) = 'object' and data ->> 'label' = label)
);
comment on table ce_public.quarters is
  'Kwartaalcijfers voor het dashboard, oplopend op seq. Alleen getallen, kwartaallabels en '
  'structuur; alle zinnen maakt de app.';

-- ---------------------------------------------------------------------------
-- 2. Publicatie: één rij met moment, herkomst en aannames
-- ---------------------------------------------------------------------------
create table ce_public.publication (
  id                      smallint primary key default 1 check (id = 1),
  generated_at            timestamptz      not null,
  generator_version       text             not null,
  discount_rate_year      double precision not null,
  horizon_quarters        integer          not null,
  grace_days              integer          not null,
  price_eur               numeric(6,2)     not null,
  cost_per_invoice_eur    numeric(6,2)     not null,
  margin_per_invoice_eur  numeric(6,2)     not null,
  first_selectable        text             not null check (first_selectable ~ '^Q[1-4] [0-9]{4}$'),
  last_quarter            text             not null check (last_quarter ~ '^Q[1-4] [0-9]{4}$'),
  quarter_count           integer          not null check (quarter_count > 0)
);
comment on table ce_public.publication is
  'Eén rij: wanneer de cijfers zijn gemaakt, door welke generatorversie, en de vaste aannames '
  '(als getallen) die de app in zijn teksten gebruikt.';

-- ---------------------------------------------------------------------------
-- 3. Rechten en RLS
-- ---------------------------------------------------------------------------
revoke all on all tables in schema ce_public from public, anon, authenticated, service_role, ce_loader;

grant select on ce_public.quarters    to anon, ce_loader;
grant select on ce_public.publication to anon, ce_loader;

alter table ce_public.quarters    enable row level security;
alter table ce_public.publication enable row level security;

create policy quarters_public_read    on ce_public.quarters    for select to anon using (true);
create policy publication_public_read on ce_public.publication for select to anon using (true);
create policy quarters_loader_read    on ce_public.quarters    for select to ce_loader using (true);
create policy publication_loader_read on ce_public.publication for select to ce_loader using (true);
