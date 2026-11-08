# Customer Equity · Supabase-datamodel en beveiliging

Status: **ontwerp ter beoordeling.** Deze migraties zijn nog niet uitgevoerd.

Customer Equity is een publieke, read-only demo. De browser gebruikt de publishable key (rol `anon`) en kan alleen geaggregeerde resultaten lezen. Alle klantdata, brondata, aannames en individuele berekeningen staan in een schema dat niet via de Data API bereikbaar is.

## Bestanden

| Migratie | Inhoud |
|---|---|
| `migrations/20261107150000_ce_roles_and_schemas.sql` | Rol `ce_loader` (NOLOGIN), schema's `ce_private` en `ce_public`, schemarechten, default privileges |
| `migrations/20261107150100_ce_private_tables.sql` | Brondata, importbatches, runs, klanten, abonnementen, aannames; views `missing_assumptions` en `subscription_monthly_financials`; RLS, policies en rechten |
| `migrations/20261107150200_ce_public_tables.sql` | `dataset_info`, `segment_month`, `sensitivity`, `data_quality`; RLS, policies en rechten; view `ce_private.publication_checks` |
| `migrations/20261107150300_ce_security_assertions.sql` | Controleert de werkelijke rechten en breekt af bij elke afwijking |

Vereist PostgreSQL 15 of hoger (`UNIQUE NULLS NOT DISTINCT`).

## Architectuur

```
Lokaal beheerscript (ce_loader, session pooler)
  import → normaliseren → simuleren → berekenen → valideren → publiceren (1 transactie)
        │
        ▼
ce_private  niet blootgesteld · RLS aan · alleen policies voor ce_loader
        │  alleen geselecteerde aggregaten
        ▼
ce_public   blootgesteld · RLS aan · anon: alleen SELECT
        ▲
Browser (publishable key → rol anon)
```

## Rechten

| Rol | `ce_private` | `ce_public` |
|---|---|---|
| `anon` (browser) | Geen schema-toegang | `USAGE`; `SELECT` op de 4 tabellen |
| `authenticated` | Geen | Geen (er is geen login) |
| `service_role` | Geen | Geen (niet nodig in v1) |
| `PUBLIC` | Geen | Geen |
| `ce_loader` | `USAGE`. `SELECT, INSERT, DELETE` op `import_batches` en `raw_ibm_telco` (geen `UPDATE`: de bron blijft ongewijzigd). `SELECT, INSERT, UPDATE, DELETE` op `simulation_runs`, `customers`, `subscriptions`, `financial_assumptions`. `SELECT` op de drie views. | `USAGE`; `SELECT, INSERT, DELETE` op de 4 tabellen (geen `UPDATE`/`TRUNCATE`) |
| `postgres` (migraties, dashboard) | Eigenaar | Eigenaar |

`ce_loader` heeft geen `CREATE` op de schema's, is geen superuser en heeft geen `BYPASSRLS`, `CREATEROLE`, `CREATEDB` of `REPLICATION`. De rol kan dus geen tabellen aanmaken of wijzigen en geen RLS omzeilen.

**Default privileges.** Voor objecten die `postgres` later in deze schema's aanmaakt, trekt migratie 1 alle automatische rechten in voor de browser- en servicerollen. Een schema-gebonden `REVOKE` kan in PostgreSQL geen globale default privileges opheffen, zoals de standaard `EXECUTE` voor `PUBLIC` op functies. Daarom trekken de migraties rechten ook per object expliciet in, en controleert migratie 4 de werkelijke situatie. Wie later een tabel of functie toevoegt, moet de rechten expliciet regelen. Migratie 4 opnieuw draaien laat zien of dat gelukt is.

## RLS-policies

| Tabel | Policies |
|---|---|
| Alle `ce_private`-tabellen | Alleen voor `ce_loader`. Brondata: `select`/`insert`/`delete`. Overige tabellen: `for all`. Andere rollen hebben geen policy, dus zien geen rijen, ook als ooit een recht zou lekken. |
| Alle `ce_public`-tabellen | `*_public_read`: `for select to anon using (true)`. `*_loader_select/insert/delete` voor `ce_loader`. Er zijn geen schrijfpolicies voor `anon`. Schrijven vanuit de browser is dus dubbel geblokkeerd: er is geen grant en geen policy. |

De views gebruiken `security_invoker = true`. Ze draaien dus met de rechten en RLS van de aanroeper, in de praktijk alleen `ce_loader`. In `ce_public` staan geen views en geen functies.

## Publieke datalaag

| Tabel | Rijen | Inhoud |
|---|---|---|
| `dataset_info` | 1 | Run, referentiedatum, historisch venster, bron en licentie, aard van de data, populatie-noot, seed, versies, d, H, churndoel, controlesom, `published_assumptions` |
| `segment_month` | 36 × 3 | Per maand en contracttype: actief begin en eind, nieuw, heractiveerd (0), gechurned, verwachte churn, omzet, variabele kosten, contributiemarge (gegenereerd), Customer Equity, aandeel gesimuleerde records |
| `sensitivity` | ~12 | CE en gemiddelde CLV op de referentiedatum per scenario: churnniveau 1,0/1,5/2,0%, ondergrens Two year 0,5% of 0,12%, d, H 36/60/120, kosten ±20% |
| `data_quality` | ~20 | Validatie- en consistentiecontroles. Alleen `pass` of `warn`: een `fail` kan niet worden gepubliceerd. |

Geen enkele rij beschrijft een individuele klant. Bedragen worden alleen gepubliceerd per contractsegment met minimaal 5 actieve records (`check (active_end >= 5)`). De browser berekent totalen, kwartalen, rolling 12 maanden en de Growth Bridge zelf uit `segment_month`.

## Publicatieprocedure (beheerscript, als `ce_loader`)

```sql
begin;
delete from ce_public.dataset_info;          -- cascade naar segment_month, sensitivity, data_quality
insert into ce_public.dataset_info (...)  values (...);
insert into ce_public.segment_month (...) values (...);   -- zonder contribution_margin (gegenereerd)
insert into ce_public.sensitivity (...)   values (...);
insert into ce_public.data_quality (...)  values (...);
-- moet 0 rijen opleveren, anders rollback:
select * from ce_private.publication_checks;
update ce_private.simulation_runs set status = 'published', published_at = now() where id = $1;
commit;
```

Bezoekers zien door de transactie altijd óf de vorige óf de nieuwe publicatie, nooit een mengvorm. Constraints bewaken:
- precies één `dataset_info`-rij;
- de stromenbalans per maand;
- maandeinden;
- de minimale celgrootte;
- één basisrij per gevoeligheidsparameter.

`publication_checks` controleert daarnaast:
- de volledigheid per contract;
- het historisch venster;
- doorlopende maanden;
- `active_start` = vorige `active_end`.

## Reproduceerbaarheid zonder klant-maandwaarden

`customer_month_values` wordt in v1 niet opgeslagen. Per run legt `ce_private.simulation_runs` vast:
- `import_batch_id` (en daarmee de SHA-256 van de bron);
- `assumption_set`, `seed`, `rng_algorithm`, `generator_version` (git-commit) en `model_version`;
- `input_checksum`: SHA-256 over de bron-hash en de geserialiseerde aannameset;
- `customer_values_checksum`: SHA-256 over de deterministische serialisatie van alle klant-maandwaarden (marge, CLV);
- `results_checksum`: SHA-256 over de gepubliceerde aggregaten. Ook opgenomen in `dataset_info`;
- `results_summary`: tellingen en totalen per maand.

Een herhaalde run met dezelfde invoer moet dezelfde drie controlesommen opleveren.

## Vereiste aannamesleutels

Scenario `base`, zonder segment (zie `ce_private.missing_assumptions`):

`cost_phone_line`, `cost_internet_dsl`, `cost_internet_fiber`, `cost_addon_basic`, `cost_streaming`, `cost_customer_care`, `cost_paper_bill`, `cost_payment_electronic_check`, `cost_payment_mailed_check`, `cost_payment_bank_transfer`, `pct_payment_credit_card`, `pct_bad_debt`, `discount_rate_annual`, `horizon_months`, `churn_target_monthly`, `two_year_churn_floor_monthly`.

De churnkansen per contract × tenureband staan in dezelfde tabel:
- `key = 'monthly_churn_probability'`, met `contract_type` en `tenure_band_min/max`, `basis = 'modelled'`;
- de relatieve log-odds uit IBM: `key = 'relative_log_odds'`, `basis = 'derived_ibm'`;
- alternatieve scenario's via `scenario`, bijvoorbeeld `churn_1_0`, `churn_2_0`, `two_year_floor_0_12`.

## Handmatige stappen na het toepassen (pas na akkoord)

1. **Migraties toepassen** in volgorde, als `postgres`. Migratie 4 moet eindigen met `Customer Equity beveiligingscontrole geslaagd.`
2. **Wachtwoord en LOGIN voor `ce_loader`**, nooit in een migratie of in Git:
   - bij voorkeur via `psql` als `postgres`: `\password ce_loader`. Dat vraagt het wachtwoord interactief en verstuurt alleen een SCRAM-hash. Daarna `alter role ce_loader login;`;
   - via de SQL-editor van Supabase kan ook, maar die bewaart querygeschiedenis. Verwijder het fragment dan direct.
   - Bewaar het wachtwoord in een wachtwoordmanager.
3. **Data API.** Voeg in *Project Settings → Data API → Exposed schemas* `ce_public` toe. **Voeg `ce_private` niet toe.** `public` en `graphql_public` blijven zoals ze zijn.
4. **Lokale verbinding**, alleen de session pooler (poort 5432, niet de transaction pooler op 6543). Zet in `.env.admin.local`, al genegeerd via `*.local`, **zonder** `VITE_`-voorvoegsel:
   ```
   SUPABASE_DB_URL=postgresql://ce_loader.<project-ref>:<wachtwoord>@<pooler-host>:5432/postgres
   ```
   Te verifiëren bij de eerste verbinding: dat de session pooler de eigen rol `ce_loader` accepteert. Lukt dat niet, dan is de directe databaseverbinding het alternatief.
5. **Beveiligingstest** (zie hieronder), eerst op lege tabellen en opnieuw na de eerste publicatie.

## Beveiligingstest

Met de publishable key, dus zoals een browser:

| Test | Verwacht |
|---|---|
| `select` op elke `ce_public`-tabel | Data |
| `insert`/`update`/`delete` op `ce_public` | Geweigerd |
| `.schema('ce_private').from('subscriptions').select()` | Fout: schema niet blootgesteld (PGRST106) |
| `.rpc(...)` op `ce_public` | Niet gevonden (er zijn geen functies) |

Daarnaast:
- migratie 4 opnieuw uitvoeren als controle;
- de Security Advisor van Supabase zonder meldingen voor deze schema's;
- na elke build in `dist/` zoeken naar `postgres://`, `postgresql://`, `sb_secret_` en `service_role`.

## Bestaande tabel `public.connection_test`

Deze tabel wordt door de migraties **niet aangeraakt**.

**Bekend:**
- een `select` met de publishable key gaf HTTP 200 met één rij;
- `anon` heeft dus `SELECT`, en RLS staat uit of er is een leesregel.

**Onbekend:**
- of RLS aan staat;
- of `anon` ook mag schrijven. Tabellen in `public` krijgen in Supabase standaard alle rechten voor `anon` en `authenticated`. Zonder RLS zou iedereen met de publieke sleutel dan rijen kunnen toevoegen, wijzigen of verwijderen.

Dit is niet getest, omdat dat een schrijfpoging zou vereisen.

**Alleen-lezen diagnose**, uit te voeren als `postgres` in de SQL-editor:

```sql
select relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class where oid = 'public.connection_test'::regclass;

select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' and tablename = 'connection_test';

select r.rolname, p.privilege
from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(privilege)
where has_table_privilege(r.rolname, 'public.connection_test', p.privilege)
order by 1, 2;
```

**Beslisregel:**
- Staat RLS aan, met alleen een `select`-policy, en heeft `anon` geen schrijfrechten of geen schrijfpolicy? Dan kan de tabel blijven.
- Anders zijn er twee opties:
  - (a) RLS aan, alleen een leespolicy, en schrijfrechten intrekken voor `anon` en `authenticated`;
  - (b) de verbindingsstatus in de app laten lezen uit `ce_public.dataset_info` en `connection_test` daarna verwijderen.

Beide alleen na akkoord.
