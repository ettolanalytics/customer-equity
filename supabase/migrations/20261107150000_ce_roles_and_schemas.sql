-- Customer Equity · migratie 1/4
-- Beheerrol ce_loader, schema's ce_private en ce_public, schemarechten en default privileges.
--
-- Wachtwoord en LOGIN voor ce_loader worden bewust NIET in deze migratie gezet.
-- Zie supabase/README.md, "Handmatige stappen na het toepassen".

-- ---------------------------------------------------------------------------
-- 1. Beheerrol
-- ---------------------------------------------------------------------------
-- Beperkte rol voor het lokale laadscript. Geen superuser,
-- geen BYPASSRLS, geen CREATEROLE/CREATEDB, geen DDL-rechten. Start als NOLOGIN.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ce_loader') then
    create role ce_loader nologin noinherit connection limit 3;
  end if;
end
$$;

comment on role ce_loader is
  'Customer Equity: beperkte beheerrol voor het lokale laadscript (Beanrise-facturen). '
  'Laadt ce_private.invoices en generator_runs en start ce_private.refresh_and_publish(). '
  'Wachtwoord wordt buiten migraties gezet.';

alter role ce_loader set statement_timeout = '10min';
alter role ce_loader set idle_in_transaction_session_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 2. Schema's
-- ---------------------------------------------------------------------------
create schema if not exists ce_private;
create schema if not exists ce_public;

comment on schema ce_private is
  'Customer Equity: ruwe facturen (Beanrise, synthetisch), generatorruns, aannames, rekenviews en refreshlog. '
  'Mag NIET worden opgenomen in de Exposed schemas van de Data API.';
comment on schema ce_public is
  'Customer Equity: uitsluitend geaggregeerde kwartaalcijfers en aannames voor het dashboard. '
  'Wordt blootgesteld aan de Data API; anon heeft alleen SELECT.';

-- Schema-toegang: eerst alles dichtzetten, daarna expliciet openen.
revoke all on schema ce_private from public, anon, authenticated, service_role;
revoke all on schema ce_public  from public, anon, authenticated, service_role;

grant usage on schema ce_private to ce_loader;
grant usage on schema ce_public  to ce_loader, anon;

-- ---------------------------------------------------------------------------
-- 3. Default privileges
-- ---------------------------------------------------------------------------
-- Objecten in deze schema's worden door de migratierol (postgres) aangemaakt.
-- Hieronder: geen automatische rechten voor browser- of servicerollen op
-- toekomstige objecten. Let op: in PostgreSQL kan een schema-gebonden REVOKE
-- geen globale default privileges opheffen (bijv. de standaard EXECUTE voor
-- PUBLIC op functies). Daarom trekken latere migraties rechten ook expliciet
-- per object in, en controleert migratie 4 de werkelijke rechten.
alter default privileges for role postgres in schema ce_private
  revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema ce_private
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema ce_private
  revoke all on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema ce_public
  revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema ce_public
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema ce_public
  revoke all on functions from public, anon, authenticated, service_role;
