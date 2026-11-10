# Customer Equity-dashboard

## Doel
Eén scherm dat beantwoordt: "Is your customer base worth more than a year ago?"
Gebouwd voor Beanrise Coffee, een fictieve klant die zijn data via een API levert,
volgens het ontwerp uit Claude Design. Op het scherm staat altijd dat het om
synthetische demodata gaat.

## Leidend ontwerp
- Claude Design-artifact "Customer Equity" (project/Main.dc.html, versie 4 nov 2026).
- De code volgt het ontwerp: opbouw, teksten, kleuren, grafieken. Niets toevoegen
  wat niet in het ontwerp staat.
- Het ontwerp wordt eerst bijgewerkt naar de opbouw hieronder (tegels, waterfall,
  teksten); pas daarna de app. Tot de overstap toont de app de oude cijfers.
- UI-taal: Engels, zoals het ontwerp.
- Alleen de subscription-variant. Geen ecommerce-variant, geen bandbreedte.

## Werkwijze (Frank Boom)
Verkennen → ontwerpen → bouwen → verankeren.
- Eén stap tegelijk. Na elke stap stoppen en laten zien wat er gedaan is.
- Kleinste oplossing die werkt.
- Stack: Claude Design, Claude Code, React + Vite, GitHub, Supabase, Netlify.

## Data
- Klant: Beanrise Coffee (fictief), tagline "fresh beans, monthly". B2C
  koffieabonnement in Nederland: elke maand één pak bonen, maandfactuur. Meerdere
  abonnementen (naar gewicht); op- en afschalen kan, de klant blijft dan klant.
- Dit project weet niet hoe de data ontstaat. Beanrise levert via een eigen API,
  datacontract v1.2: alleen lezen, JSON, `/v1`, API-sleutel in de header `X-API-Key`;
  bedragen in centen excl. btw (9%) met de btw apart; tijden in UTC (ISO 8601);
  paginering met cursor (`{data, next_cursor, has_more}`, maximaal 1.000 per pagina);
  fouten 401, 429 met Retry-After, 5xx; geen persoonsgegevens.
- Endpoints: `/v1/status` (as_of en het aantal rijen per endpoint t/m as_of), `/v1/plans`
  (met size_grams), `/v1/product-costs`, `/v1/customers?updated_since=`,
  `/v1/subscriptions?updated_since=`, `/v1/subscription-events?after_id=`,
  `/v1/invoices?after_id=`. Klanten alleen met id, created_at en updated_at. Alle ids zijn
  integers. period_start en period_end zijn datums; period_end is exclusief en gelijk aan
  de volgende period_start (de API rekent met de factuurdag: 31 jan → 29 feb → 31 mrt).
- Facturen en events veranderen nooit. Elke betaalpoging is een eigen rij: eerst failed,
  daarna een nieuwe rij paid voor dezelfde periode. Status alleen paid of failed. Op elke
  factuur staan subscription_id, customer_id en plan_id. Een terugkerende klant krijgt een
  nieuw abonnement onder dezelfde customer_id.
- Ophalen: dagelijks, incrementeel, door de GitHub Action `beanrise-daily.yml` naar
  `ce_private.bz_*`. Elke lading staat in `ce_private.loads` (as_of, tijdstip, aantallen
  per endpoint, controlesom) en is alles-of-niets; de aantallen moeten gelijk zijn aan
  `/v1/status`.
- In de data voor de app: Q1 2020 t/m het laatste afgesloten kwartaal; kiesbaar vanaf
  Q1 2021. Een kwartaal is afgesloten zodra as_of na het kwartaaleinde ligt; daarna
  verandert het niet meer (alle definities gebruiken alleen wat op de peildatum betaald was).

## Vaste aannames (in ce_private.settings_v2, niet instelbaar in de app)
- Valuta: euro; bedragen excl. btw.
- Discontovoet: 10% per jaar, per maand: 1,10^(1/12) − 1.
- Horizon: 60 maanden. Op het scherm heet de waarde "CLV"; de afbakening (5 jaar,
  resterende waarde, contributiemarge, 10% disconto) staat alleen in How we calculate.
- Respijt: 30 dagen.
- Rekenperiode: de maand (factuurcyclus); het scherm toont kwartalen.
- Prijzen en kostprijzen komen uit de API, niet uit de aannames.
- Modelkeuzes (uit de validatie): segmentatie per startabonnement, terugkerende klanten
  apart, marge met overstappen.
- Acquisitiekosten tellen niet mee.

## Definities
Alle begrippen gelden op een peildatum (kwartaaleinde).

**Klanten en churn**
- **Betaalde factuur:** een factuur met status paid. Op een peildatum tellen alleen
  facturen die op of vóór die peildatum betaald zijn (paid_at). Mislukte betaalpogingen
  (status failed) tellen nergens mee.
- **Vervaldatum:** period_end van de laatste betaalde factuur van de klant, over al zijn
  abonnementen.
- **Actieve klant:** op de peildatum (kwartaaleinde) heeft de klant een betaalde factuur
  met period_start op of vóór de peildatum, en ligt zijn vervaldatum + 30 dagen ná de
  peildatum. Er is geen aparte groep "respijt" of "past_due": klanten binnen de 30 dagen
  tellen als actief.
- **Churn:** een klant churnt als hij uiterlijk 30 dagen na zijn vervaldatum geen volgende
  factuur heeft betaald (period_start en paid_at allebei uiterlijk vervaldatum + 30 dagen).
  De churn telt in het kwartaal waarin die 30 dagen aflopen. Betaalt hij later toch, dan
  blijft het churn en telt hij bij die betaling als reacquired klant. Op- of afschalen, een
  mislukte betaling of de status past_due is geen churn, zolang er binnen de 30 dagen
  betaald wordt. Een churn beëindigt de klantperiode; het retentiemodel, de klantenstroom
  en de waterfall gebruiken dezelfde klantperioden.
- **Blijvende klant:** de klant is aan het begin én aan het eind van het kwartaal actief,
  in dezelfde klantperiode.
- **Nieuwe klant:** de klant had aan het begin van het kwartaal nog nooit een betaalde
  factuur, en is aan het eind van het kwartaal actief. Klant worden: vanaf de eerste
  betaalde factuur.
- **Reacquired klant:** de klant had vóór het kwartaal al een betaalde factuur, begint in
  het kwartaal een nieuwe klantperiode en is aan het eind van het kwartaal actief in die
  klantperiode. Dat kan ook een klant zijn die aan het begin actief was en in hetzelfde
  kwartaal churnde: hij telt dan als churn én als reacquired. Zijn klantduur begint
  opnieuw bij 1.
- **Binnen één kwartaal komen en gaan:** een klantperiode die in het kwartaal begint én in
  het kwartaal door churn eindigt, telt niet als nieuw, niet als reacquired en niet als
  churn.
- **Klantperiode:** per klant een aaneengesloten reeks betaalde facturen, waarin elke
  volgende factuur begint én betaald is uiterlijk 30 dagen na de vervaldatum van de
  vorige, ook als de klant tussendoor een nieuw abonnement afsloot. Een klantperiode
  eindigt precies op het moment dat de churndefinitie een churn telt. De klantenstroom
  telt per klantperiode (blijvend, churn, nieuw, reacquired, of binnen het kwartaal
  gekomen en gegaan). Volgnummer 1 = groep "eerste", 2 en hoger = groep "terugkeer".
- **Klantduur k:** aantal betaalde facturen in de huidige klantperiode.
- **Abonnement van een factuur:** plan_id van de factuur. Startabonnement: dat van de
  eerste betaalde factuur van de klantperiode. Huidig abonnement: dat van de laatste.
- **Churnpercentage:** klanten die aan het begin van het kwartaal actief waren en in het
  kwartaal zijn gechurnd ÷ actieve klanten aan het begin.
- **Acquisition** = nieuw + reacquired (= eind − begin + churn). Op het scherm staan nieuw
  en reacquired apart; in de JSON als losse velden naast het totaal (acquiredCustomers).
- **Omzet:** som van amount_excl_vat van de betaalde facturen met period_start in het
  kwartaal.

**Customer equity**
- Customer equity (CE) = de som van de CLV van alle actieve klanten = N × avg CLV.
- N = aantal actieve klanten = begin + new + reacquired − churn.

**Gemiddelde CLV**
- avg CLV = Σ CLV_i ÷ N, over alle actieve klanten.
- Verandering per kwartaal (van begin q0 naar eind q1): Δ avg CLV = avg1 − avg0 =
  Customer mix + Existing customer value.
  - Blijvers S: klantperioden die actief zijn aan begin én eind. N_S = hun aantal;
    avgS0, avgS1 = hun gemiddelde CLV aan begin en eind.
  - Existing customer value = (N_S ÷ N1) × (avgS1 − avgS0).
  - Customer mix = (avg1 − avg0) − Existing customer value.
  - Per jaar: de som van de vier kwartalen.

**CLV per klant**
- CLV_i = r_i × V_i, met V_i = Σ (t = 1..60) M_i(t) × [ S(k_i + t − 1) ÷ S(k_i − 1) ] ÷ (1 + d)^t:
  de verwachte verdisconteerde marge over de komende 60 maanden.
- r_i = respijtfactor: 1 als de klant een lopende betaalde periode heeft (vervaldatum ná
  de peildatum). Zit hij in de 30 dagen respijt zonder lopende betaalde periode, dan is
  r_i de gemeten kans op laat verlengen: het aandeel klanten in respijt op de vier vorige
  kwartaaleinden dat binnen de 30 dagen toch betaalde (Q3 2026: 0,248).
- m_a = marge per factuur van abonnement a: (bedrag excl. btw − kostprijs per levering),
  gemiddeld over de betaalde facturen van dat abonnement in de 12 maanden t/m de
  peildatum (som ÷ aantal), tegen seizoens- en schommeleffecten. De kostprijs is die op
  period_start.
- M_i(t) = verwachte marge per factuur t maanden vooruit voor een klant met huidig
  abonnement a: Σ_b P^t[a, b] × m_b, met P de overstapkansen per maand: van de facturen
  die in dezelfde klantperiode op een factuur van abonnement a volgen, het aandeel op
  abonnement b (12 maanden t/m de peildatum; b = a is blijven). Zonder overstapcorrectie (als de validatie die niet kiest):
  M_i(t) = m_a.
- E_i = verwacht aantal betaalde facturen in de komende 60 maanden, verdisconteerd (V_i
  zonder de marge): E_i = Σ (t = 1..60) [ S(k_i + t − 1) ÷ S(k_i − 1) ] ÷ (1 + d)^t
  - S(t) = B(α, β + t) ÷ B(α, β): de kans dat een klant meer dan t facturen betaalt
    (shifted-beta-geometric, Fader & Hardie 2007: elke klant heeft een vaste kans θ per
    maand om op te zeggen, θ ~ Beta(α, β)). S(k + t − 1) ÷ S(k − 1) is de kans dat een klant
    met k betaalde facturen ook factuur k + t betaalt. (Niet S(k + t) ÷ S(k): dat rekent
    alsof factuur k + 1 al zeker is.)
  - α en β van de groep van de klant: per startabonnement voor de groep "eerste", één
    schatting voor de groep "terugkeer" (keuze van de validatie). Geschat per
    kwartaaleinde, met maximum likelihood op de klantperioden zoals bekend op dat
    kwartaaleinde; lopende perioden tellen als "nog niet gestopt" (gecensureerd).
  - k_i = klantduur: het aantal betaalde facturen in zijn huidige klantperiode;
  - d = disconto per maand = 1,10^(1/12) − 1.
- Klanten met dezelfde groep, hetzelfde start- en huidig abonnement, dezelfde klantduur en
  dezelfde respijtstatus hebben dezelfde CLV. SQL rekent per groep; de uitkomst is gelijk
  aan per klant.

**Velden voor How we calculate (geen tegels)**
- Expected invoices = Σ (r_i × E_i) ÷ N.
- Margin per future invoice = Σ (r_i × V_i) ÷ Σ (r_i × E_i): de gemiddelde marge per
  toekomstige factuur, inclusief verwachte overstappen.
- Daarmee geldt exact: avg CLV = Expected invoices × Margin per future invoice. (Zonder r_i
  in Expected invoices klopt dat niet; het verschil is de waarde die klanten in respijt door
  de respijtfactor kwijtraken.)

## Opbouw van het scherm
Van boven naar beneden:
1. Customer equity: hero-kaart + lijngrafiek, met de antwoordzin.
2. Twee tegels, de factoren: Active customers en Average CLV (tegel "CLV").
3. De drivers, elk groepje visueel onder zijn factor: onder Active customers de tegels
   New, Reacquired en Churn; onder Average CLV de tegels Customer mix en Existing
   customer value.
4. Waterfall.
5. How we calculate.

De tegels tonen exact de drivers van customer equity:
- customer equity = active customers × average CLV;
- active customers = vorig kwartaal + new + reacquired − churn;
- Δ average CLV = Customer mix + Existing customer value (per kwartaal exact).
Churn (tegel) = het aantal gechurnde klanten in het kwartaal. Customer mix en Existing
customer value zijn bijdragen aan de verandering van de gemiddelde CLV in het kwartaal, in
euro per klant met teken; hun vergelijking met vorig kwartaal en een jaar eerder is een
verschil in euro. Geen verwachte churn (geen gestippelde lijn, geen "Exp." in de hover) en
geen blok Plans. Margin per future invoice en Expected invoices zijn geen tegels.
Elke tegel: waarde, vergelijking met vorig kwartaal en een jaar eerder, minigrafiek,
gedeelde hover over alle grafieken.

Grafieken (lijngrafiek customer equity en de minigrafieken):
- De laatste drie jaar t/m het gekozen kwartaal, op de as Q1–Q4, één lijn per jaar.
  Jaren zonder data vallen weg (bij Q1 2021 alleen 2020 en 2021).
- Kleur per rol, vaste volgorde: gekozen jaar blauw #2a78d6, vorig jaar oranje
  #eb6834, twee jaar terug groen #1baf7a (gevalideerd op kleurenblindheid).
- Legenda: bij de lijngrafiek, plus jaartallen aan het eind van de lijnen; voor
  de tegels één gedeelde legenda naast "What drives the value".
- Hover toont alleen het punt onder de muis: het dichtstbijzijnde kwartaal en
  daar de dichtstbijzijnde lijn (één stip), bijv. "Q2 2025 · 21,073". Gedeeld:
  alle grafieken tonen hetzelfde kwartaal en jaar. Zonder hover het gekozen kwartaal.
- Lijnen en stippen zijn in alle grafieken even dik/groot op het scherm (in pixels,
  niet meegeschaald met de grafiek): 1,75 px, gekozen jaar 2,25 px; grote grafiek
  2 en 2,5 px.
- Verticale assen: maximaal 3 cijfers per label ("20k", "€250", "€31.9",
  "92.2%", "€5.3M", "−€1"); in de minigrafieken hooguit 3 ticks. Bij Customer mix en
  Existing customer value is de nullijn zichtbaar.

## Verklaring van de verandering (waterfall)
Twee waterfalls, met een toggle Year / Quarter rechtsboven op de waterfall-kaart. Jaar is
de standaard; periodelabel en titel veranderen mee. Per kwartaal, met N0 en N1 = actieve
klanten aan begin en eind en avg0 = gemiddelde CLV aan het begin:
1. New customers = new × avg0
2. Reacquired customers = reacquired × avg0
3. Churn = − churn × avg0
4. Customer mix = N1 × Customer mix
5. Existing customer value = N1 × Existing customer value

De som is exact CE1 − CE0, omdat N1 − N0 = new + reacquired − churn. De jaarwaterfall is de
som van de vier kwartaalwaterfalls (bedragen en aantallen). Op het scherm: positieve
bedragen onder Added, negatieve onder Lost. Zonder vorig kwartaal in de data (Q1 2020) is er
geen kwartaalwaterfall, zonder kwartaal een jaar eerder in de data (Q1–Q4 2020) geen
jaarwaterfall: de velden zijn null. De onderdelen moeten exact optellen tot de verandering
in customer equity. Dit wordt in code gecontroleerd. Sluit het niet, dan melden en niet
stilletjes wegpoetsen.

## Schermteksten
Afwijkingen van en aanvullingen op de teksten in het ontwerp:
1. Antwoordzin: vertelt wat er gebeurde én waarom, langs customer equity = actieve klanten ×
   gemiddelde CLV, over de laatste vier kwartalen, bijv.:
   "Customer equity grew €1.8m (+13.7%) vs Q3 2025, because both the customer base and
   average CLV grew. Over the last four quarters, the customer base grew by 1,870 to
   31,611: 6,407 customers were acquired (5,729 new, 678 reacquired) and 4,537 churned.
   Average CLV rose by €30.11 to €463.41, mainly because existing customers became more
   valuable."
   - Het "because"-deel volgt uit de richting van klanten, CLV en customer equity: beide
     omhoog/omlaag, of welke van de twee de doorslag gaf.
   - De reden voor de CLV is het grootste (in absolute waarde) van Customer mix en Existing
     customer value over de vier kwartalen: "mainly because existing customers became more /
     less valuable" of "mainly because of the customer mix".
   - Geen zin over verwachte churn.
   - Alle getallen komen uit de data; de app kiest alleen woorden.
2. Tooltips: Customer mix: "Change in average CLV because different customers joined and
   left, for example new customers who are not yet expected to stay as long." Existing
   customer value: "Change in average CLV because customers who stayed became more or less
   valuable, for example by staying longer or changing plans." Reacquired: "Customers who
   churned earlier (more than 30 days without a subscription) and came back." (het aantal
   dagen komt uit de aannames). Churn: zonder zin over verwachte churn.
3. Waterfall-labels: "New customers", "Reacquired customers", "Churn", "Customer mix",
   "Existing customer value". Toelichting bijv. "1,499 new customers × €452.57 average CLV
   at the start." en "Average CLV +€0.80 from the customer mix × 31,611 customers."
4. How we calculate: (1) CLV met de afbakening: contributiemarge (prijs min kostprijs per
   levering, excl. btw, 12-maandsgemiddelde per abonnement, inclusief verwachte op- en
   afschalingen) over de komende vijf jaar (60 maandfacturen), verdisconteerd tegen 10% per
   jaar; alleen wat nog te verdienen is, geen acquisitiekosten, niets na vijf jaar; hoe lang
   een klant blijft volgt uit het shifted-beta-geometric model. Rekenvoorbeeld met
   clvExample uit de JSON. (2) Customer equity = actieve klanten × gemiddelde CLV; klanten
   in respijt tellen mee tegen de kans dat ze toch verlengen. (3) Waarom de gemiddelde CLV
   verandert: Customer mix en Existing customer value; avg CLV = Expected invoices × Margin
   per future invoice. (4) Verandering per kwartaal: de vijf balken; het jaar telt de vier
   kwartalen op. (5) "Acquisition costs are not included. Amounts exclude VAT."
5. Actieve klant: "An active customer is a customer with a running subscription,
   or within 30 days after it expired."
6. Header: bedrijfsnaam "Beanrise Coffee", tagline "fresh beans, monthly" en het
   label "Synthetic demo data" (tooltip: fictief bedrijf, synthetische data; ook
   zichtbaar in de PDF), initialen "LJ", "Data as of {datum}". Met de kwartaalknop kies je
   de kiesbare kwartalen (vanaf Q1 2021): alleen kwartalen waarvoor het hele scherm gevuld
   is. Standaard het laatste kwartaal. Grafieken tonen de drie jaar t/m het gekozen
   kwartaal, dat dan het "huidige" kwartaal is. De Export-knop opent het afdrukvenster van
   de browser, waarin de gebruiker "Opslaan als PDF" kiest. Afdrukopmaak: A4 liggend,
   zonder zijbalk en knoppen.
7. Alle CLV-bedragen met twee decimalen (bijv. €463.41), ook in de antwoordzin en
   onder de lijngrafiek; Customer mix en Existing customer value met teken ("+€0.80").
   Customer equity in miljoenen met één decimaal ("€14.6m"); veranderingen onder een
   miljoen in duizenden ("€56k"), vanaf een miljoen in miljoenen ("+€1.8m"), ook in de
   waterfall. Verschil in procentpunten: "pp".

## Architectuur
```
Beanrise-API (contract v1.2)
  → GitHub Action beanrise-daily.yml (dagelijks 04:15 UTC, ook met de hand)
    1. scripts/ingest_beanrise.py (ce_loader): incrementeel ophalen (after_id,
       updated_since, as_of als bovengrens) → tijdelijke bestanden → één transactie
       naar ce_private.bz_* + ce_private.loads; controles incl. aantallen = /v1/status
    2. scripts/estimate_sbg.py: ce_private.refresh_v2_base() (klantperioden, toestand per
       kwartaaleinde, klantenstroom, marge, overstappen, respijtfactor) → sBG-schatting
       per kwartaaleinde en segment (scripts/sbg.py) → ce_private.sbg_runs/sbg_params
       → ce_private.publish_v2(): waardetabel, CLV, CE, mix/existing, vijf balken,
         publication_checks_v2 → ce_public.quarters_v2 + publication_v2 (anon: alleen lezen)
    3. validatiejob (1e van de maand of met de hand): scripts/validate_holdout.py --save
       → ce_private.validation_runs
  → Netlify-build: scripts/fetch-quarters.mjs (npm prebuild) → statische site
```
- Live (tot de overstap): de app leest nog ce_public.quarters en ce_public.publication,
  bevroren sinds 9 nov 2026 (de oude rekenweg draait niet meer; de oude tabellen en views
  zijn leeg). De overstap naar quarters_v2 gebeurt in één stap: publicatie omzetten en
  direct de build met de nieuwe app.
- Rekenregels staan in SQL: ophalen in supabase/migrations/20261110120000_ce_beanrise_api_tables.sql,
  afleiden en rekenen in supabase/migrations/*_ce_v2_*.sql (de nieuwste definitie geldt).
  Python schat alleen α en β. Elke stap
  publiceert alles-of-niets; de fout staat in ce_private.refresh_log of ce_private.loads.
- Een fit die niet convergeert houdt de publicatie tegen (run failed, geen publicatie).
  De controles in publication_checks_v2: klantenstroom sluit; Δ avg CLV = Customer mix +
  Existing customer value (per kwartaal en per jaar); de vijf balken tellen op tot
  CE1 − CE0 (< €1); jaar = som van vier kwartalen (bedragen op 5 cent, aantallen exact);
  CE aan het begin = CE van het vorige kwartaal; CE = N × avg CLV; avg CLV = Expected
  invoices × Margin per future invoice; parameters compleet, geconvergeerd en van de
  laatste lading; DERL stijgt met de klantduur; marge per abonnement > 0; vorm (de enige
  tekst is een kwartaallabel); volledigheid; een afgesloten kwartaal verandert niet meer
  (tolerantie één cent).
- Rekenen is deterministisch: de fit voegt invoer samen en sorteert die, Newton-stappen
  brengen het optimum op ~1e-12, en de views tellen niet parallel op.
- De app rekent niets. Hij leest src/data/quarters.json, dat bij elke build uit Supabase
  wordt opgehaald en niet in git staat. Is Supabase onbereikbaar, dan faalt de build met
  een melding; nooit terugvallen op oude data.
- Er staat geen tekst in de data: alleen getallen, kwartaallabels en structuur.
  Alle zinnen maakt de app.
- Keep-alive: .github/workflows/supabase-keepalive.yml doet twee keer per week een
  leesquery op ce_public (gratis plan pauzeert na 7 dagen zonder activiteit).
  GitHub zet geplande workflows uit na 60 dagen zonder activiteit in de repo.
- Publieke repo, dus publieke logs: secrets worden gemaskeerd (ook host en wachtwoord los),
  scripts drukken alleen aantallen af, geen artifacts. `docs/` (ontwerpnotities) staat in
  .gitignore en wordt nooit gecommit.
- Sleutels: Netlify krijgt alleen SUPABASE_URL en SUPABASE_PUBLISHABLE_KEY. GitHub-secrets:
  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (keep-alive), BEANRISE_API_URL, BEANRISE_API_KEY
  en CE_LOADER_DB_URL (session pooler). Lokaal in .env.local; SUPABASE_DB_URL (postgres,
  voor migraties) staat alleen lokaal. De service-role key wordt nergens gebruikt.
- Omvang: database ±330 MB (grens gratis plan 500 MB); de dagelijkse lading waarschuwt
  boven 450 MB.

## Scripts
Python-omgeving: `.venv` met scripts/requirements.txt (in de Action:
scripts/requirements-ci.txt).
- `apply_migrations.py`: migraties op Supabase als postgres; met een bestandsnaam alleen die
  migratie plus de beveiligingsasserties, in één transactie.
- `ingest_beanrise.py`: ophalen via de API (ook `--dry-run --max-pages N` als test).
- `estimate_sbg.py`: verversen, schatten, publiceren naar quarters_v2 (`--no-publish`).
- `sbg.py`: het sBG-model (likelihood, fit, convergentie, overleving, segment).
- `validate_holdout.py`: de validatie (`--save` schrijft naar ce_private.validation_runs).
- `npm run build` (of `npm run fetch-data`): data ophalen en de app bouwen.
- Overige scripts in scripts/ zijn uit de eerste opzet, buiten gebruik (load_beanrise.py en
  test_supabase.py stoppen direct) en worden later verwijderd.

## Validatie van het CLV-model
scripts/validate_holdout.py, maandelijks in de Action. Holdout: schatten op de data zoals
bekend op T, vergelijken met de 24 maanden daarna. Beslist wordt op de foutpercentages.
De validatiejob faalt alleen bij een overschreden foutnorm of een fit die niet convergeert;
een gefaalde validatie houdt de publicatie niet tegen (alleen een convergentiefout doet dat).
- V1a overleving: grootste maandfout totaal ≤ 1,5%, per startabonnement en voor de groep
  eerste klantperiode ≤ 3%. Terugkerende klanten: apart gerapporteerd, niet getoetst
  (geaccepteerd op 3,13% tegen 3%).
- V1b gerealiseerde marge (gewaardeerd tegen de 12-maandsmarge per abonnement op T): fout
  over 24 maanden totaal ≤ 2%, per abonnement ≤ 3%.
- V3 kalibratie per klantduur: ≥ 90% van de cellen (≥ 200 klanten) binnen het 95%-binomiale
  interval of ≤ 2 procentpunt.
- V4 convergentie bij elke run: drie startpunten, kleine gradiënt, positief definiete Hessiaan.
- Diagnose, niet getoetst: het aantal maanden buiten het 95%-voorspelinterval (V1a, V1b) en de
  vergelijking met de oude methode (V2, vaste retentie).
- Beslisregel: het eenvoudigste niveau (samen → terugkeerders apart → per startabonnement →
  beide) dat V1a en V3 haalt; een ingewikkelder niveau wint als de holdout-log-likelihood
  meer dan 2 × (extra parameters) hoger is. Marge met overstappen als het huidige abonnement
  V1b niet haalt en de overstapvariant wel.
- Gekozen (11 nov 2026): per startabonnement met terugkerende klanten apart (model D), marge
  met overstappen. De overstapvariant wijkt klein maar systematisch af (veel maanden buiten
  het interval); waarschijnlijk vangt hij afschalen vóór opzeggen niet.

## Code
- Hergebruiken: Vite/React-basis, src/lib/format.ts.
- Niet meer gebruiken: Shapley-decompositie, value/brand/relationship-drivers,
  margeopbouw per order, CLV-retentie over vier kwartalen, verwachte churn (oud ontwerp).

## Open punten
- Claude Design bijwerken naar deze opbouw; daarna de app (types, tegels, waterfall,
  teksten) op quarters_v2 en de overstap.
- Opruimen na de overstap: oude tabellen, views en refresh_and_publish(), de scripts uit de
  eerste opzet, en de keep-alive (twee weken na een stabiele dagelijkse run).
- De 60-dagenregel van GitHub voor geplande workflows: nog geen oplossing ingebouwd.
