# Customer Equity-dashboard

## Doel
Eén scherm dat beantwoordt: "Is your customer base worth more than a year ago?"
Gebouwd op synthetische data van een fictief bedrijf (Beanrise Coffee), volgens het
ontwerp uit Claude Design. Op het scherm staat altijd dat het om synthetische
demodata gaat.

## Leidend ontwerp
- Claude Design-artifact "Customer Equity" (project/Main.dc.html, versie 4 nov 2026).
- De code volgt het ontwerp: opbouw, teksten, kleuren, grafieken. Niets toevoegen
  wat niet in het ontwerp staat.
- UI-taal: Engels, zoals het ontwerp.
- Alleen de subscription-variant. Geen ecommerce-variant, geen bandbreedte.

## Werkwijze (Frank Boom)
Verkennen → ontwerpen → bouwen → verankeren.
- Eén stap tegelijk. Na elke stap stoppen en laten zien wat er gedaan is.
- Kleinste oplossing die werkt.
- Stack: Claude Design, Claude Code, React + Vite, GitHub, Supabase, Netlify.

## Data
- Bedrijf: Beanrise Coffee (fictief), tagline "fresh beans, monthly". B2C
  koffieabonnement: elke maand één pak bonen, maandfactuur, één product, één prijs.
  Geen proefperiode, geen pauzeren of overslaan. Churn = geen volgende factuur.
- Synthetisch: scripts/generate_beanrise.py, generator v1.1, seed 20261109.
  Reproduceerbaar: dezelfde seed geeft dezelfde bestanden (SHA-256 in manifest.json).
- Parameters:
  - circa 20.000 actieve klanten; basisinstroom 1.360 per kwartaal
    (evenwicht: 0,85 × 0,08 × 20.000), zodat het bestand zonder campagne stabiel is;
  - basischurn 8% per kwartaal; geen seizoenspatroon;
  - 15% van de vertrekkers komt terug binnen 12 maanden (80% na 2–6 maanden,
    de rest na 6–12); campagneklanten 5%; wie terugkomt krijgt de basischurn;
  - campagne Q2–Q4 2021 bovenop de basis: +1.800, +3.600, +1.800 klanten;
  - churn van campagneklanten per kwartaal sinds aanmelding (curve V2):
    25 / 20 / 18 / 16 / 14 / 12%, daarna 8,5%.
- Verhaal: piek eind 2021 (circa +28%), kater in 2022 (churn rond de jaarwisseling
  ruim 10%, CLV-dal Q4 2022), daarna geleidelijk terug richting 20.000.
- Periode: facturen van 1 okt 2018 t/m 31 okt 2026 (de generator warmt intern op
  vanaf 2014). De buffer vanaf okt 2018 is nodig zodat Q1 2021 volledig klopt,
  inclusief Q1 2020 als kwartaal een jaar eerder (CLV-retentie over 2019, en
  terugkerende klanten tot 12 maanden terug). Getoetst: de cijfers vanaf deze
  buffer zijn gelijk aan die uit de volledige historie.
- Rekenkwartalen Q1 2019 – Q3 2026; in de data voor de app Q1 2020 – Q3 2026
  (27 kwartalen); kiesbaar Q1 2021 – Q3 2026.
- Klant worden: vanaf de eerste factuur (elke factuur is betaald).
- data/synthetic/ staat in .gitignore; de facturen staan in Supabase (ce_private).

## Vaste aannames (in ce_private.settings, niet instelbaar in de app)
- Prijs €24,95 per factuur, kostprijs €14,00 per factuur (pak bonen + bezorging),
  marge €10,95 per factuur. De hele periode gelijk.
- Valuta: euro.
- Discontovoet: 10% per jaar.
- CLV-horizon: maximaal 20 kwartalen (5 jaar).
- Respijt: 30 dagen.
- De app leest deze aannames als getallen uit ce_public.publication en zet ze in
  de schermteksten; ze staan niet vast in de code.

## Definities
- Actieve klant: vervaldatum + 30 dagen ligt ná de peildatum (kwartaaleinde).
- Churn: geen nieuw geldig abonnement binnen 30 dagen na de vervaldatum.
  Telt in het kwartaal waarin die 30 dagen aflopen.
- Er is geen groep "respijt": klanten binnen de 30 dagen tellen als actief.
- Churnpercentage: klanten die aan het begin van het kwartaal actief waren en in
  het kwartaal zijn gechurnd ÷ actieve klanten aan het begin.
- Verwachte churn: churnpercentage van hetzelfde kwartaal vorig jaar
  × actieve klanten aan begin kwartaal.
- Nieuwe klant: eerste transactie ooit valt in het kwartaal én de klant is aan
  het eind van het kwartaal actief.
- Klanten die binnen één kwartaal binnenkomen en weer weggaan, tellen niet als
  nieuw en niet als churn.
- Reacquired klant: eerder gechurnd (langer dan 30 dagen weg), niet actief aan
  het begin van het kwartaal en wel aan het eind.
- Acquisition = nieuw + reacquired (= eind − begin + churn). Op het scherm staan
  nieuw en reacquired altijd apart zichtbaar; in de JSON als losse velden
  (newCustomers, reacquiredCustomers) naast het totaal (acquiredCustomers).
- Omzet: som van de facturen in het kwartaal.
- Marge per klant per kwartaal: (aantal facturen × €10,95) ÷ gemiddelde van de
  actieve klanten aan begin en eind van het kwartaal.
- CLV: marge per kwartaal × verwachte duur als klant (max. 20 kwartalen),
  verdisconteerd tegen 10% per jaar.
- CLV-retentie per kwartaal = 1 − gemiddeld churnpercentage van de vorige
  4 kwartalen. Zijn er minder dan 4, het gemiddelde van de kwartalen die er zijn.
- Customer equity: actieve klanten × gemiddelde CLV.
- Acquisitiekosten tellen niet mee.

## Verklaring van de verandering (waterfall)
Twee waterfalls, met een toggle Year / Quarter op het scherm. Jaar is de
standaard. Beide tegen de gemiddelde CLV aan het begin van de periode (V0), met
N0 en N1 = actieve klanten aan begin en eind, V1 = CLV aan het eind.

Jaar (bijv. Q3 2025 → Q3 2026):
- + nieuwe klanten (som van de vier kwartalen) × V0
- + reacquired klanten (som) × V0
- − werkelijke churn (som) × V0
- ± marge-effect en ± retentie-effect (zie onder)

Kwartaal (bijv. Q2 2026 → Q3 2026):
- + nieuwe klanten × V0
- + reacquired klanten × V0
- − verwachte churn × V0
- ± (verwachte − werkelijke churn) × V0
- ± marge-effect en ± retentie-effect (zie onder)

CLV-verandering, gesplitst (beide waterfalls):
- Vm = CLV met de marge van het eind en de retentie van het begin.
- Marge-effect = (Vm − V0) × N1.
- Retentie-effect = (V1 − Vm) × N1.

Op het scherm: positieve bedragen onder Added, negatieve onder Lost.
Zonder vorig kwartaal in de data (Q1 2020) is er geen kwartaalwaterfall, zonder
kwartaal een jaar eerder in de data (Q1–Q4 2020) geen jaarwaterfall: de velden
zijn null.
De onderdelen moeten exact optellen tot de verandering in customer equity.
Dit wordt in code gecontroleerd. Sluit het niet (bijv. door terugkerende klanten),
dan melden en niet stilletjes wegpoetsen.

## Opbouw van het scherm
Van boven naar beneden:
1. Customer equity: hero-kaart + lijngrafiek.
2. Twee tegels, de factoren: Active customers en Average CLV.
3. De drivers, elk groepje visueel onder zijn factor: onder Active customers de
   tegels New, Reacquired en Churn; onder Average CLV de tegels Margin per
   customer en Retention (4-quarter average).
4. Waterfall.
5. How we calculate.

De tegels tonen exact de drivers van customer equity:
- customer equity = active customers × average CLV;
- active customers = vorig kwartaal + new + reacquired − churn;
- average CLV volgt uit margin per customer en retention (10% disconto per jaar,
  20 kwartalen, beide vast).
Churn (tegel) = het aantal werkelijk gechurnde klanten in het kwartaal; hoort bij
active customers. Retention = 1 − gemiddeld churnpercentage van de vorige
4 kwartalen; hoort bij de CLV. publication_checks controleert per kwartaal dat deze
drie verbanden exact kloppen (afwijking > €1 of > 0 klanten: niet publiceren en melden).
Elke tegel: waarde, vergelijking met vorig kwartaal en een jaar eerder,
minigrafiek, gedeelde hover over alle grafieken.

Grafieken (lijngrafiek customer equity en de minigrafieken):
- De laatste drie jaar t/m het gekozen kwartaal, op de as Q1–Q4, één lijn per jaar.
  Jaren zonder data vallen weg (bij Q1 2021 alleen 2020 en 2021).
- Kleur per rol, vaste volgorde: gekozen jaar blauw #2a78d6, vorig jaar oranje
  #eb6834, twee jaar terug groen #1baf7a (gevalideerd op kleurenblindheid).
- Legenda: bij de lijngrafiek, plus jaartallen aan het eind van de lijnen; voor
  de tegels één gedeelde legenda naast "What drives the value". De Churn-tegel
  houdt de gestippelde lijn voor verwachte churn van het gekozen jaar.
- Hover toont alleen het punt onder de muis: het dichtstbijzijnde kwartaal en
  daar de dichtstbijzijnde lijn (één stip), bijv. "Q2 2025 · 21,073". Gedeeld:
  alle grafieken tonen hetzelfde kwartaal en jaar. Churn: "Q2 2025 · 1,658 ·
  Exp. 1,655"; zonder hover het gekozen kwartaal.
- Lijnen en stippen zijn in alle grafieken even dik/groot op het scherm (in pixels,
  niet meegeschaald met de grafiek): 1,75 px, gekozen jaar 2,25 px; grote grafiek
  2 en 2,5 px.
- Verticale assen: maximaal 3 cijfers per label ("20k", "€250", "€31.9",
  "92.2%", "€5.3M"); in de minigrafieken hooguit 3 ticks.

## Schermteksten
Afwijkingen van en aanvullingen op de teksten in het ontwerp:
1. Antwoordzin: vertelt wat er gebeurde én waarom, langs customer equity =
   actieve klanten × gemiddelde CLV, over de laatste vier kwartalen:
   "Customer equity fell €56k (−1.1%) vs Q3 2025, because the smaller customer
   base outweighed the higher average CLV. Over the last four quarters, the
   customer base shrank by 357 to 20,626: 6,158 customers were acquired (5,342
   new, 816 reacquired) and 6,515 churned. Average CLV rose by €1.65 to €254.02,
   mainly because retention improved. Over the last four quarters, 8 fewer
   customers churned than expected."
   - Het "because"-deel volgt uit de richting van klanten, CLV en customer
     equity: beide omhoog/omlaag, of welke van de twee de doorslag gaf.
   - De reden voor de CLV is het grootste van marge-effect en retentie-effect
     uit de jaarwaterfall.
   - Het churndeel gaat over de kwartalen met verwachte churn; het aantal
     kwartalen staat in de zin.
   - Alle getallen komen uit de data; de app kiest alleen woorden.
2. Rekenvoorbeeld "How we calculate": rekent met `retention` uit de JSON. Tekst:
   "Assuming x% churn per quarter (average of the previous four quarters)".
3. Gestippelde lijn verwachte churn: alleen waar een waarde is. In de hovertekst
   "Expected —" bij kwartalen zonder waarde.
4. Tegels New en Reacquired staan los (er is geen aparte Acquisition-tegel meer;
   acquisition = new + reacquired staat in de antwoordzin). Tooltip Reacquired:
   "Customers who churned earlier (more than 30 days without a subscription) and
   came back." (het aantal dagen komt uit de aannames) Tooltip Retention: "Average churn of the previous four quarters,
   used to calculate CLV. Differs from this quarter's churn." De Churn-tegel
   houdt de gestippelde lijn voor verwachte churn ("Expected —" in de hover
   waar geen waarde is).
   Waterfall-labels: "New customers", "Reacquired customers", "Churn" (jaar) of
   "Expected churn" en "Lower/Higher churn than expected" (kwartaal), "Lower/Higher
   margin per customer", "Lower/Higher retention". Toelichting bij marge bijv.
   "Margin per customer €31.97 → €31.95 per quarter × 20,626 customers."
   Toggle Year / Quarter rechtsboven op de waterfall-kaart; periodelabel en titel
   veranderen mee.
   How we calculate, stap 3: noemt new en reacquired en de splitsing in marge-
   en retentie-effect.
5. Actieve klant: "An active customer is a customer with a running subscription,
   or within 30 days after it expired."
6. Header: bedrijfsnaam "Beanrise Coffee", tagline "fresh beans, monthly" en het
   label "Synthetic demo data" (tooltip: fictief bedrijf, synthetische data; ook
   zichtbaar in de PDF), initialen "LJ". Met de kwartaalknop kies je Q1 2021 –
   Q3 2026: alleen kwartalen waarvoor het hele scherm gevuld is (vergelijking met
   vorig jaar, antwoordzin en waterfall). Standaard het laatste kwartaal.
   Grafieken tonen de drie jaar t/m het gekozen kwartaal, dat dan
   het "huidige" kwartaal is. De Export-knop opent het
   afdrukvenster van de browser, waarin de gebruiker "Opslaan als PDF" kiest.
   Afdrukopmaak: A4 liggend, zonder zijbalk en knoppen.
7. Alle CLV-bedragen met twee decimalen (bijv. €254.02), ook in de antwoordzin en
   onder de lijngrafiek. Customer equity in miljoenen met één decimaal ("€5.2m");
   veranderingen onder een miljoen in duizenden ("€56k"), vanaf een miljoen in
   miljoenen ("+€1.3m"), ook in de waterfall. Verschil in procentpunten: "pp".

## Architectuur
```
generate_beanrise.py (lokaal, eenmalig, vaste seed) → Parquet
  → load_beanrise.py (als ce_loader) → Supabase ce_private.invoices
  → materialized views: mv_spells → mv_quarter_flows → mv_quarter_money
    → mv_quarters → mv_quarters_json → mv_publication
  → ce_private.refresh_and_publish(): verversen, publication_checks, publiceren
  → ce_public.quarters + ce_public.publication (anon: alleen lezen)
  → Netlify-build: scripts/fetch-quarters.mjs (npm prebuild) → statische site
```
- Rekenregels staan in SQL (supabase/migrations/20261107150250_ce_transform.sql).
  scripts/build_quarters.py is de Python-referentie; SQL moet daar exact mee
  overeenkomen.
- refresh_and_publish() werkt alles-of-niets: faalt een controle (stroom sluit,
  waterfalls tellen op, de drie driververbanden, vorm, volledigheid, aantal
  facturen), dan blijft ce_public ongewijzigd en staat de fout in
  ce_private.refresh_log.
- De app rekent niets. Hij leest src/data/quarters.json ({ assumptions, quarters }),
  dat bij elke build uit Supabase wordt opgehaald en niet in git staat. Is Supabase
  onbereikbaar, dan faalt de build met een melding; nooit terugvallen op oude data.
- Er staat geen tekst in de data: alleen getallen, kwartaallabels en structuur.
  Alle zinnen maakt de app (gecontroleerd in publication_checks).
- Keep-alive: .github/workflows/supabase-keepalive.yml doet twee keer per week een
  leesquery op ce_public (gratis plan pauzeert na 7 dagen zonder activiteit).
  GitHub zet geplande workflows uit na 60 dagen zonder activiteit in de repo.
- Sleutels: Netlify en GitHub krijgen alleen SUPABASE_URL en
  SUPABASE_PUBLISHABLE_KEY. Databaseverbindingen (SUPABASE_DB_URL, CE_LOADER_DB_URL)
  staan alleen lokaal in .env.local. De service-role key wordt nergens gebruikt.

## Scripts en volgorde
Python-omgeving: `.venv` met scripts/requirements.txt.
1. `generate_beanrise.py`: synthetische facturen naar data/synthetic/.
2. `check_beanrise.py`: toetst de generator (reproduceerbaar, buffer, basischurn,
   instroom, golf, churn, CLV, reacquisitie, omvang) met de Python-referentie.
3. `apply_migrations.py`: migraties op Supabase (eenmalig, als postgres).
4. `load_beanrise.py`: facturen laden als ce_loader, vingerafdruk vergelijken,
   refresh starten.
5. `compare_sql_python.py`: SQL-uitkomst in Supabase tegen de Python-referentie.
6. `test_supabase.py`: beveiliging (Data API en database) en faalroute.
7. `npm run build` (of `npm run fetch-data`): data ophalen en de app bouwen.

## Code
- Hergebruiken: Vite/React-basis, src/lib/format.ts.
- Niet meer gebruiken: Shapley-decompositie, value/brand/relationship-drivers,
  margeopbouw per order (oud ontwerp).

## Validatie van het CLV-model (sBG, in opbouw in ce_public.quarters_v2)
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

## Open punten
- pg_cron (beschikbaar, versie 1.6.4, nog niet geïnstalleerd) voor een geplande
  refresh bij live data. De cronjob valt onder de database-time-out van 2 minuten;
  de refresh duurt nu 14–26 s. Voorstellen:
  - de cronjob zelf een ruimere grens geven:
    `set statement_timeout = '10min'; select ce_private.refresh_and_publish()`;
  - in refresh_and_publish() `set local work_mem = '64MB'` (nu 2 MB, sorteren gaat
    naar schijf).
  Na een geplande refresh moet ook een Netlify-build starten om de nieuwe cijfers
  te tonen.
