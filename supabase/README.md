# Customer Equity · Supabase

Supabase bevat de ruwe facturen van Beanrise Coffee (fictief, synthetisch), rekent daar met SQL de kwartaalcijfers uit volgens CLAUDE.md, en publiceert alleen geaggregeerde cijfers. Het dashboard (Netlify) haalt die bij de build op en is daarna statisch.

```
generate_beanrise.py (lokaal, eenmalig, vaste seed) → Parquet
        │ load_beanrise.py (ce_loader, session pooler)
        ▼
ce_private   invoices, generator_runs, settings, refresh_log
             mv_spells → mv_quarter_flows → mv_quarter_money → mv_quarters
             → mv_quarters_json → mv_publication;  publication_checks
        │ refresh_and_publish(): verversen → controleren → publiceren (of niets)
        ▼
ce_public    quarters (jsonb per kwartaal), publication (aannames)   ← anon: alleen SELECT
        │ scripts/fetch-quarters.mjs (npm prebuild, publishable key)
        ▼
Netlify      statische site
```

## Migraties

| Bestand | Inhoud |
|---|---|
| `20261107150000_ce_roles_and_schemas.sql` | Rol `ce_loader` (NOLOGIN), schema's, schemarechten, default privileges |
| `20261107150100_ce_private_tables.sql` | `invoices`, `generator_runs`, `settings` (aannames, rekenperiode), `refresh_log`; RLS en rechten |
| `20261107150200_ce_public_tables.sql` | `quarters`, `publication`; RLS en rechten |
| `20261107150250_ce_transform.sql` | Hulpfuncties, materialized views, `publication_checks`, `refresh_and_publish()` |
| `20261107150300_ce_security_assertions.sql` | Controleert de werkelijke rechten en breekt af bij elke afwijking |
| `20261110120000_ce_beanrise_api_tables.sql` | `bz_*`-tabellen (ruwe data van de Beanrise-API, contract v1.2) en `loads`; RLS en rechten |
| `20261110140000_ce_v2_derive.sql` | `settings_v2`; afleiden uit `bz_*`: klantperioden, toestand per kwartaaleinde, klantenstroom per klantperiode, marge en overstappen per abonnement, late-verlengfactor, `sbg_input` |
| `20261110150000_ce_v2_value.sql` | `sbg_runs`, `sbg_params`, `validation_runs`; DERL, CLV, customer equity, waterfall (acht balken), `publication_checks_v2`, `refresh_v2_base()`, `publish_v2()`; `ce_public.quarters_v2` en `publication_v2` (nog niet live) |
| `20261110160000_ce_v2_deterministic.sql` | Geen parallelle optellingen bij verversen en publiceren (vaste volgorde) |
| `20261110170000_ce_v2_tolerance.sql` | `jsonb_close()`: controle "afgesloten kwartaal ongewijzigd" met een tolerantie van één cent |
| `20261110180000_ce_v2_mix_existing.sql` | Marge per factuur op de peildatum; gemiddelde CLV = Customer mix + Existing customer value; waterfall met vijf balken; nieuwe JSON en controles (ontwerp v3.4) |

Uitvoeren: `.venv/bin/python scripts/apply_migrations.py` (alle bestanden in één transactie; stopt als `ce_private` al bestaat). Een nieuwe migratie op een bestaand schema: `.venv/bin/python scripts/apply_migrations.py supabase/migrations/<bestand>.sql` (die migratie plus de beveiligingsasserties, in één transactie).

## Rechten

| Rol | `ce_private` | `ce_public` |
|---|---|---|
| `anon` (publishable key) | Geen schema-toegang | `SELECT` op `quarters` en `publication` |
| `authenticated`, `service_role`, `PUBLIC` | Geen | Geen |
| `ce_loader` | `invoices`: SELECT, INSERT, TRUNCATE. `generator_runs`: SELECT, INSERT. `settings`, `refresh_log`, views: SELECT. EXECUTE op `refresh_and_publish()`. `bz_invoices`, `bz_subscription_events`, `loads`: SELECT, INSERT. `bz_customers`, `bz_subscriptions`: SELECT, INSERT, UPDATE. `bz_plans`, `bz_product_costs`: SELECT, INSERT, DELETE. `sbg_runs`, `sbg_params`, `validation_runs`: SELECT, INSERT; v2-views: SELECT; EXECUTE op `refresh_v2_base()` en `publish_v2()` | SELECT |
| `postgres` | Eigenaar | Eigenaar |

`refresh_and_publish()` is `SECURITY DEFINER` (eigenaar `postgres`) met een vaste `search_path`; alleen deze functie schrijft in `ce_public`. `ce_loader` herlaadt met TRUNCATE in plaats van DELETE, zodat er geen miljoenen dode rijen achterblijven (opslaggrens 500 MB).

## Refresh en controles

`select ce_private.refresh_and_publish();` doet in één blok met exception-handler:

1. de zes materialized views verversen, in volgorde;
2. `publication_checks` lezen: elke rij is een fout (stroom sluit, waterfalls tellen op, de drie driververbanden, vorm van de data, volledigheid, publicatie, aantal facturen);
3. alleen als er geen fouten zijn: `ce_public.quarters` en `ce_public.publication` vervangen.

Faalt iets, dan wordt het hele blok teruggedraaid (ook de views en `ce_public`) en komt alleen de fout met details in `ce_private.refresh_log`. De functie geeft `published` of `failed: …` terug.

Later, bij live data: een schema met pg_cron, bijvoorbeeld `select cron.schedule('ce-refresh', '15 3 * * *', 'select ce_private.refresh_and_publish()');` (na `create extension pg_cron`). Daarna moet ook een Netlify-build starten om de nieuwe cijfers te tonen.

## Scripts (lokaal)

| Script | Doel | Verbinding |
|---|---|---|
| `scripts/apply_migrations.py` | Migraties uitvoeren, pg_cron-beschikbaarheid melden | `SUPABASE_DB_URL` (postgres) |
| `scripts/load_beanrise.py` | Facturen laden, vingerafdruk vergelijken, refresh starten | `CE_LOADER_DB_URL` |
| `scripts/ingest_beanrise.py` | Beanrise-API incrementeel ophalen naar `bz_*`, controles, registratie in `loads` (dagelijks via `.github/workflows/beanrise-daily.yml`) | `BEANRISE_API_URL`, `BEANRISE_API_KEY`, `CE_LOADER_DB_URL` |
| `scripts/estimate_sbg.py` | `refresh_v2_base()`, sBG schatten per kwartaaleinde en segment (`scripts/sbg.py`), `publish_v2()` naar `ce_public.quarters_v2` (dagelijks in dezelfde Action) | `CE_LOADER_DB_URL` |
| `scripts/validate_holdout.py` | Holdoutvalidatie V1a/V1b/V2/V3/V4 en het advies voor segmentatie en marge (maandelijks in de Action, `--save`) | `CE_LOADER_DB_URL` |
| `scripts/compare_sql_python.py` | SQL-uitkomst vergelijken met `build_quarters.build()` | `CE_LOADER_DB_URL` |
| `scripts/test_supabase.py` | Beveiliging (Data API en database) en faalroute | publishable key + `CE_LOADER_DB_URL` |
| `scripts/fetch-quarters.mjs` | `npm prebuild`: cijfers ophalen voor de build | `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` |

Python-omgeving: `python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt`.

## Pauze (gratis plan)

Een project zonder activiteit pauzeert na 7 dagen. `.github/workflows/supabase-keepalive.yml` doet twee keer per week een leesquery. Is Supabase toch onbereikbaar, dan faalt de Netlify-build met een melding en blijft de vorige deploy online; er wordt nooit oude data gebruikt.
