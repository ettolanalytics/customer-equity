# Customer Equity-dashboard

## Doel
Eén scherm dat beantwoordt: "Is your customer base worth more than a year ago?"
Gebouwd voor Beanrise Coffee, een fictieve klant die zijn data via een API levert.
Op het scherm staat altijd dat het om synthetische demodata gaat.

## Leidend ontwerp
- Leidend is de goedgekeurde proefversie op branch `proef-v2` (nov 2026): opbouw, teksten,
  kleuren en grafieken zoals hieronder beschreven. Claude Design-artifact "Customer Equity"
  (project/Main.dc.html) loopt daarop achter en wordt bijgewerkt (zie Open punten).
- Niets toevoegen wat niet in deze beschrijving of het ontwerp staat.
- UI-taal: Engels.
- Alleen de subscription-variant. Geen ecommerce-variant, geen bandbreedte.

## Werkwijze (Frank Boom)
Verkennen → ontwerpen → bouwen → verankeren.
- Eén stap tegelijk. Na elke stap stoppen en laten zien wat er gedaan is.
- Kleinste oplossing die werkt.
- Stack: Claude Design, Claude Code, React + Vite, GitHub, Supabase, Netlify.

## Beveiliging en git
- Nooit sleutels, wachtwoorden of verbindings-URL's met wachtwoord afdrukken of committen.
- Sleutels staan lokaal in `.env.local` (nooit in git). Netlify krijgt alleen SUPABASE_URL en
  SUPABASE_PUBLISHABLE_KEY. GitHub-secrets: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (keep-alive),
  BEANRISE_API_URL, BEANRISE_API_KEY en CE_LOADER_DB_URL (session pooler). SUPABASE_DB_URL
  (postgres, voor migraties) staat alleen lokaal. De service-role key wordt nergens gebruikt.
- Publieke repo, dus publieke logs: secrets worden gemaskeerd (ook host en wachtwoord los),
  scripts drukken alleen aantallen af, geen artifacts.
- `docs/` (ontwerpnotities) staat in .gitignore en wordt nooit gecommit.
- Niet mergen of pushen naar `main` zonder akkoord. Werk gebeurt op een eigen branch.

## Data
- Klant: Beanrise Coffee (fictief), tagline "fresh beans, monthly". B2C
  koffieabonnement in Nederland: elke maand één pak bonen, maandfactuur. Drie abonnementen
  naar gewicht (250 g, 500 g, 1 kg); op- en afschalen kan, de klant blijft dan klant.
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
- Publicatie voor de app: `ce_public.quarters_v2` (één rij per kwartaal, JSON) en
  `ce_public.publication_v2` (aannames, as_of, eerste kiesbare en laatste kwartaal).
  Q1 2020 t/m het laatste afgesloten kwartaal; kiesbaar vanaf Q1 2021 (alleen kwartalen
  waarvoor het hele scherm gevuld is). Rekenkwartalen beginnen eerder (Q1 2019), zodat ook
  het eerste kiesbare kwartaal vergelijkingen heeft. Een kwartaal is afgesloten zodra as_of
  na het kwartaaleinde ligt; daarna verandert het niet meer (alle definities gebruiken alleen
  wat op de peildatum betaald was).

## Vaste aannames (in ce_private.settings_v2, niet instelbaar in de app)
- Valuta: euro; bedragen excl. btw.
- Discontovoet: 10% per jaar, per maand: 1,10^(1/12) − 1. €1 over vijf jaar is vandaag
  €0.62 waard (horizon_discount_factor in publication_v2).
- Horizon: 60 maandfacturen (5 jaar); niets daarna telt.
- Respijt: 30 dagen. De respijtfactor (zie CLV per klant) komt per kwartaal uit de data.
- Rekenperiode: de maand (factuurcyclus); het scherm toont kwartalen.
- Prijzen en kostprijzen komen uit de API, niet uit de aannames.
- Modelkeuzes (uit de validatie): segmentatie per startabonnement, terugkerende klanten
  apart (model D), marge met overstappen (margin_method `switching`).
- Acquisitiekosten tellen (vooralsnog) niet mee.

## Definities
**Momenten: stock tegenover flow**
- Stocks worden gemeten op de laatste dag van het kwartaal (peildatum): actieve klanten,
  gemiddelde CLV, customer equity.
- Flows zijn gebeurtenissen gedurende het kwartaal: new, reacquired, churn. Ze worden geteld
  als gebeurtenissen, niet als unieke klanten.

**Klanten en churn**
- **Betaalde factuur:** een factuur met status paid. Op een peildatum tellen alleen
  facturen die op of vóór die peildatum betaald zijn (paid_at). Mislukte betaalpogingen
  (status failed) tellen nergens mee.
- **Klantperiode:** per klant een aaneengesloten reeks betaalde facturen, waarin elke
  volgende factuur begint én betaald is uiterlijk 30 dagen na de vervaldatum van de vorige,
  ook als de klant tussendoor een nieuw abonnement afsloot. Volgnummer 1 = groep "eerste",
  2 en hoger = groep "terugkeer".
- **Vervaldatum:** period_end van de laatste betaalde factuur in de klantperiode.
- **Actieve klant (stock):** op de peildatum is de klantperiode begonnen (eerste betaalde
  factuur bekend) en ligt de vervaldatum + 30 dagen ná de peildatum. Klanten binnen de 30
  dagen respijt tellen als actief.
- **Churn (flow):** elke keer dat de 30 dagen na de vervaldatum verstrijken zonder volgende
  betaling; de klantperiode eindigt dan. Telt in het kwartaal waarin die 30 dagen aflopen,
  ook twee keer voor dezelfde klant in één kwartaal. Betaalt hij later toch, dan blijft het
  churn en telt hij bij die betaling als reacquired. Op- of afschalen of een mislukte betaling
  is geen churn, zolang er binnen de 30 dagen betaald wordt.
- **New (flow):** elke eerste klantperiode ooit die in het kwartaal begint, ook als die klant
  binnen het kwartaal weer vertrekt.
- **Reacquired (flow):** elke volgende klantperiode die in het kwartaal begint (terugkeer na
  meer dan 30 dagen zonder abonnement), ook meerdere per klant per kwartaal. Klantduur begint
  opnieuw bij 1.
- **Komen en gaan binnen één kwartaal:** telt mee als new (of reacquired) én als churn. Zo
  geldt exact: actief eind = actief begin + new + reacquired − churn. De regel per
  klantperiode staat in `ce_private.spell_events()`.
- **Blijvers in het kwartaal:** klantperioden die aan het begin én aan het eind van het
  kwartaal actief zijn.
- **Klantduur k:** aantal betaalde facturen in de huidige klantperiode.
- **Abonnement van een factuur:** plan_id van de factuur. Startabonnement: dat van de
  eerste betaalde factuur van de klantperiode. Huidig abonnement: dat van de laatste.
- **churnRate** (in de data, niet op het scherm): zuiver percentage, gechurnd uit de
  beginstand ÷ actieve klanten aan het begin.
- **Omzet:** som van amount_excl_vat van de betaalde facturen met period_start in het
  kwartaal (in de data, niet op het scherm).

**Customer equity**
- Customer equity (CE) = de som van de CLV van alle actieve klanten op de peildatum
  = N × gemiddelde CLV.

**CLV per klant**
- CLV_i = r_i × V_i, met V_i = Σ (t = 1..60) M_i(t) × [ S(k_i + t − 1) ÷ S(k_i − 1) ] ÷ (1 + d)^t:
  de verwachte verdisconteerde marge over de komende 60 maandfacturen.
- r_i = respijtfactor: 1 als de klant een lopende betaalde periode heeft (vervaldatum ná
  de peildatum). Zit hij in de 30 dagen respijt zonder lopende betaalde periode, dan is
  r_i het aandeel klanten in respijt op de vier vorige kwartaaleinden dat binnen de 30
  dagen toch betaalde (mv_bz_late; Q3 2026: 24.8%, Q3 2025: 22.4%).
- m_a = marge per factuur van abonnement a: (bedrag excl. btw − kostprijs per levering),
  gemiddeld over de betaalde facturen van dat abonnement in de 12 maanden t/m de
  peildatum (som ÷ aantal). De kostprijs is die op period_start.
- M_i(t) = verwachte marge per factuur t maanden vooruit voor een klant met huidig
  abonnement a: Σ_b P^t[a, b] × m_b, met P de overstapkansen per maand (van de facturen die
  in dezelfde klantperiode op een factuur van abonnement a volgen, het aandeel op abonnement
  b; 12 maanden t/m de peildatum).
- S(t) = B(α, β + t) ÷ B(α, β): de kans dat een klant meer dan t facturen betaalt
  (shifted-beta-geometric, Fader & Hardie 2007: elke klant heeft een vaste kans θ per maand
  om op te zeggen, θ ~ Beta(α, β)). S(k + t − 1) ÷ S(k − 1) is de kans dat een klant met k
  betaalde facturen ook factuur k + t betaalt.
- α en β per segment: per startabonnement voor de groep "eerste", één schatting voor de
  groep "terugkeer". Geschat per kwartaaleinde met maximum likelihood op de klantperioden
  zoals bekend op dat kwartaaleinde; lopende perioden tellen als "nog niet gestopt".
- d = disconto per maand = 1,10^(1/12) − 1.
- Klanten met hetzelfde segment, hetzelfde huidig abonnement, dezelfde klantduur en dezelfde
  respijtstatus hebben dezelfde CLV. SQL rekent per groep (mv_bz_vgrid); de uitkomst is
  gelijk aan per klant. De CLV per klant wordt niet per klant opgeslagen.
- In de data (niet op het scherm): Expected invoices = Σ (r_i × E_i) ÷ N en Margin per future
  invoice = Σ (r_i × V_i) ÷ Σ (r_i × E_i), met E_i = V_i zonder de marge; avg CLV = Expected
  invoices × Margin per future invoice. clvExample: rekenvoorbeeld voor een nieuwe klant op
  het abonnement waarmee de meeste nieuwe klanten in het kwartaal begonnen.

## Verandering verklaren
Beide verklaringen vergelijken twee foto's: begin tegen eind.
- **Kwartaal:** het begin van het kwartaal (eind vorig kwartaal) tegen het eind. Groepen per
  klantperiode: blijvers (actief op beide momenten, zelfde klantperiode), vertrekkers (alleen
  aan het begin), instromers (alleen aan het eind; new of reacquired).
- **Jaar:** het eind van hetzelfde kwartaal vorig jaar tegen het eind van het gekozen
  kwartaal, per klant (mv_bz_year_rows): blijvers (actief op beide momenten), vertrekkers
  (alleen een jaar eerder), new (alleen nu, eerste factuur ooit na het beginmoment),
  reacquired (alleen nu, al eerder klant). Wie tussendoor kwam en ging komt niet voor.
  Het jaar is dus níet de som van vier kwartalen.

**CLV-kaart "What changed average CLV"** (euro per klant, met teken), voor beide momenten:
- Existing customers = (N_blijvers ÷ N_eind) × (CLV blijvers eind − CLV blijvers begin).
- Customer mix = nieuwkomers + vertrekkers (samen het mix effect):
  - nieuwkomers = (N_in ÷ N_eind) × (CLV instromers eind − CLV blijvers begin);
  - vertrekkers = (N_uit ÷ N_begin) × (CLV blijvers begin − CLV vertrekkers begin);
    positief betekent: vertrekkers waren minder waard, hun vertrek verhoogde het gemiddelde.
- Existing customers + Customer mix = verandering van de gemiddelde CLV, exact.
- Velden: QoQ `existingCustomerValue`, `customerMix` (= `customerMixNewcomers` +
  `customerMixLeavers`); YoY `existingCustomerValueYoY`, `customerMixYoY` (=
  `customerMixNewcomersYoY` + `customerMixLeaversYoY`). De velden `…Last4Quarters` (som van vier kwartalen) staan nog in
  de data, maar niet op het scherm; `yearSummary` bepaalt alleen nog welke kwartalen kiesbaar
  zijn.

**Waterfall** (euro, elke klant tegen zijn eigen CLV):
- New customers = som van de CLV van de instromers (new) op het eindmoment.
- Reacquired customers = idem voor reacquired.
- Churn = − som van de CLV van de vertrekkers op het beginmoment.
- Existing customers = som over de blijvers van (CLV eind − CLV begin)
  (= N_eind × het deel Existing customers van de CLV-kaart).
- New + Reacquired + Churn + Existing = CE eind − CE begin, exact. Klanten die binnen het
  kwartaal komen en gaan hebben op geen van beide momenten een CLV en tellen als €0.
- Aantallen in de toelichting: kwartaal = de gebeurtenissen van de tegels; jaar = netto
  (een jaar eerder + new + reacquired − churn = nu).
- Zonder vorig kwartaal in de data (Q1 2020) is er geen kwartaalwaterfall, zonder kwartaal een
  jaar eerder (Q1–Q4 2020) geen jaarwaterfall: de velden zijn null.

## Opbouw van het scherm
- Header: logo, "Beanrise Coffee", "fresh beans, monthly", het label "Synthetic demo data"
  (ook in de PDF), "Data as of {datum}", kwartaalkeuze (kiesbare kwartalen, standaard het
  laatste), knop Export (afdrukvenster van de browser, "Opslaan als PDF"), initialen "LJ".
  Afdrukopmaak: A4 liggend, zonder zijbalk, knoppen en tooltips.
- Zijbalk: Overview, Value drivers, Contribution, Explanation of CLV model.
- Titel "Customer Equity", ondertitel "The value of your current customers · {kwartaal}".
  Geen executive summary en geen antwoordzin.

Van boven naar beneden:
1. **Customer equity**: hero-kaart met de waarde (€14.6m), daaronder "{N} active customers ×
   {€X} average CLV", QoQ en YoY (pilletje met % en bedrag in k/m). Daarnaast de lijngrafiek
   "Customer Equity over time".
2. **Value drivers** (gedeelde jaarlegenda naast de kop): tegels Active customers en Average
   CLV (waarde, QoQ en YoY met % en bedrag, minigrafiek). Daaronder, elk onder zijn factor:
   - onder Active customers: New, Reacquired, Churn (waarde dit kwartaal, QoQ en YoY = dit
     kwartaal tegen hetzelfde kwartaal vorig jaar, aantal en %, minigrafiek); churn omhoog is
     oranje;
   - onder Average CLV: de kaart "What changed average CLV" met blokken QoQ en YoY, elk drie
     horizontale bars: "Existing customers became more/less valuable", "Change in customer
     mix" (tooltip met de twee delen) en "Change in average CLV" (totaal, neutraal grijs).
     Elk blok een eigen schaal met nul in beeld; positief groen #1baf7a, negatief oranje
     #eb6834 (zoals de waterfall). Geen minigrafiek, geen gedeelde hover.
3. **Contribution**: de waterfall "Why did customer equity change by {bedrag}?", toggle Year /
   Quarter (jaar is standaard), periode "{van} → {naar}". Balken: Start, New customers,
   Reacquired customers, Existing customers became more/less valuable, Churn, End; positieve
   onder Added, negatieve onder Lost. Toelichting per balk:
   - Start / End: "Total CLV of {N} active customers"
   - New customers: "Total CLV of {N} new customers"
   - Reacquired customers: "Total CLV of {N} returning customers"
   - Existing customers…: "Change in total CLV of {N} existing customers"
   - Churn: jaar "Total CLV a year ago of {N} customers who left", kwartaal "Total CLV at the
     start of the quarter of {N} customers who left"
4. **Explanation of CLV model**: één blok (zie Schermteksten).

Grafieken (lijngrafiek customer equity en de minigrafieken):
- De laatste drie jaar t/m het gekozen kwartaal, op de as Q1–Q4, één lijn per jaar.
  Jaren zonder data vallen weg (bij Q1 2021 alleen 2020 en 2021).
- Kleur per rol, vaste volgorde: gekozen jaar blauw #2a78d6, vorig jaar oranje
  #eb6834, twee jaar terug groen #1baf7a (gevalideerd op kleurenblindheid).
- Legenda: bij de lijngrafiek, plus jaartallen aan het eind van de lijnen; voor
  de tegels één gedeelde legenda naast "Value drivers".
- Hover toont alleen het punt onder de muis: het dichtstbijzijnde kwartaal en
  daar de dichtstbijzijnde lijn (één stip), bijv. "Q2 2025 · 21,073". Gedeeld:
  alle grafieken tonen hetzelfde kwartaal en jaar. Zonder hover het gekozen kwartaal.
- Lijnen en stippen zijn in alle grafieken even dik/groot op het scherm (in pixels,
  niet meegeschaald met de grafiek): 1,75 px, gekozen jaar 2,25 px; grote grafiek
  2 en 2,5 px.
- Verticale assen: maximaal 3 cijfers per label ("20k", "€250", "€5.3M"); in de
  minigrafieken hooguit 3 ticks.

## Schermteksten
1. Tooltips (het meetmoment staat aan het eind):
   - Customer Equity: "Customer equity: the sum of the CLV of all active customers. The
     expected future margin of your current customers, in today's euros. Measured on the
     last day of the quarter."
   - Active customers: "Active customers: customers with a running subscription, or within
     30 days after it expired. Previous quarter + new + reacquired − churn. Measured on the
     last day of the quarter."
   - Average CLV: "Average value of an active customer: the margin we expect from them over
     the next 5 years, in today's euros at 10% per year. Measured on the last day of the
     quarter."
   - New: "New: first-ever paid subscriptions, also when the customer left again within the
     quarter. Counts all events during the quarter."
   - Reacquired: "Reacquired: customers who churned earlier (more than 30 days without a
     subscription) and came back; a customer can come back more than once. Counts all events
     during the quarter."
   - Churn: "Churn: each time 30 days passed after a subscription ended without a new
     payment; a customer can churn more than once. Counts all events during the quarter."
   - What changed average CLV: "How much each part contributed to the change in average CLV,
     compared with last quarter and with a year ago."
   - Change in customer mix (woorden volgen het teken; "too" alleen als beide groepen
     dezelfde kant op afwijken): "The effect of who joined and who left. New and returning
     customers were worth less/more than existing ones (−€X); customers who left were worth
     less/more too, which raised/lowered the average (+€Y)."
2. Explanation of CLV model (getallen uit de data):
   "A customer's CLV is the margin we expect them to bring in over the next 5 years, counted
   in today's euros. It combines three things:
   1. How long the customer stays. We predict how long each customer will stay using the
      shifted-beta-geometric model. It assumes every customer has their own chance of
      cancelling each month, and that these chances differ between customers. Customers who
      cancel easily tend to leave early, so the longer a customer has stayed, the more likely
      they are to stay. The model is fitted per starting plan, separately for returning
      customers, on all subscriptions up to the quarter. A customer whose subscription
      expired less than 30 days ago counts at 24.8% of their CLV, because that is the share
      that still renews.
   2. What each invoice earns. Price minus the cost of each delivery, excluding VAT,
      averaged over the last 12 months per plan, including expected up- and downgrades. The
      cost of acquiring the customer is (currently) not included.
   3. When it comes in. Margin further in the future counts for less: 10% per year, so €1 in
      five years counts as €0.62 today. Only the next 60 monthly invoices count; nothing
      after 5 years.
   Example: a new 500 g customer renews next month with a 97.3% chance. Over 5 years they are
   expected to pay 30.1 more invoices, counted in today's euros. At €10.76 margin per
   invoice, plus expected plan changes, their CLV is €338.56."
   "per starting plan" en "separately for returning customers" volgen uit de geschatte
   segmenten; het voorbeeld uit clvExample.
3. Notatie:
   - Customer equity in miljoenen met één decimaal ("€14.6m").
   - Veranderingen in euro onder €1m in duizenden, vanaf €1m in miljoenen met één decimaal,
     met teken ("+€578k", "+€1.8m", "−€1.3m"), ook in de waterfall.
   - CLV-bedragen met twee decimalen ("€463.41"); bijdragen met teken ("+€0.80").
   - Aantallen met duizendtalscheiding ("31,611"); verschillen met teken ("+521").
   - Percentages in de pilletjes met één decimaal zonder teken, richting met ▲/▼.

## Architectuur
```
Beanrise-API (contract v1.2)
  → GitHub Action beanrise-daily.yml (dagelijks 04:15 UTC, ook met de hand)
    1. scripts/ingest_beanrise.py (ce_loader): incrementeel ophalen (after_id,
       updated_since, as_of als bovengrens) → tijdelijke bestanden → één transactie
       naar ce_private.bz_* + ce_private.loads; controles incl. aantallen = /v1/status
    2. scripts/estimate_sbg.py: ce_private.refresh_v2_base() (klantperioden, toestand per
       kwartaaleinde, marge, overstappen, respijtfactor) → sBG-schatting per kwartaaleinde
       en segment (scripts/sbg.py) → ce_private.sbg_runs/sbg_params
       → ce_private.publish_v2(): waardetabel, CLV, CE, klantenstroom, jaarrijen,
         CLV-kaart, waterfalls, publication_checks_v2 → ce_public.quarters_v2 +
         publication_v2 (anon: alleen lezen)
    3. validatiejob (op de 1e van de maand of met de hand): scripts/validate_holdout.py --save
       → ce_private.validation_runs
  → Netlify-build: scripts/fetch-quarters.mjs (npm prebuild) → statische site
```
- Live (tot de overstap): de build op `main` leest nog ce_public.quarters en
  ce_public.publication, bevroren sinds 9 nov 2026. De proefversie leest quarters_v2 met
  `CE_DATA=v2` (`npm run dev:v2`, `npm run fetch-data:v2`). Zonder CE_DATA=v2 bouwt proef-v2
  niet (de types passen niet op de oude data).
- Rekenregels staan in SQL: ophalen in supabase/migrations/20261110120000_ce_beanrise_api_tables.sql,
  afleiden en rekenen in supabase/migrations/*_ce_v2_*.sql (de nieuwste definitie geldt).
  Python schat alleen α en β. Elke stap publiceert alles-of-niets; de fout staat in
  ce_private.refresh_log of ce_private.loads.
- Een fit die niet convergeert houdt de publicatie tegen (run failed, geen publicatie).
  publish_v2() publiceert ook niet als horizon_discount_factor leeg is of buiten (0, 1] valt.
- Rekenen is deterministisch: de fit voegt invoer samen en sorteert die, Newton-stappen
  brengen het optimum op ~1e-12, en de views tellen niet parallel op.
- De app rekent niets. Hij leest src/data/quarters.json, dat bij elke build uit Supabase
  wordt opgehaald en niet in git staat. Is Supabase onbereikbaar, dan faalt de build met
  een melding; nooit terugvallen op oude data.
- Er staat geen tekst in de data: alleen getallen, kwartaallabels en structuur.
  Alle zinnen maakt de app.

**Controles in publish_v2 (ce_private.publication_checks_v2)**; één falende controle = niet
publiceren, de details staan in refresh_log:
- `stroom`: actief eind = begin + new + reacquired − churn (gebeurtenissen); begin = eind
  vorig kwartaal.
- `stroom_jaar`: actief nu − actief een jaar eerder = som van de flows over vier kwartalen.
- `flows_4kw`: de velden …Last4Quarters = som van de vier kwartalen.
- `flows_yoy`: YoY van new, reacquired en churn = verschil van de twee kwartaalwaarden
  (pct = abs ÷ waarde een jaar eerder); leeg zonder kwartaal een jaar eerder.
- `mix_delen`: nieuwkomers + vertrekkers = mix effect (≤ 1 cent), per kwartaal en over vier
  kwartalen.
- `clv_yoy_delen`: de drie YoY-delen van de CLV-kaart = CLV YoY (≤ 1 cent).
- `clv_yoy_mix`: customerMixYoY = customerMixNewcomersYoY + customerMixLeaversYoY (≤ 1 cent),
  en leeg precies als de delen leeg zijn.
- `jaar_existing`: Existing customers in de jaarwaterfall = actief nu × YoY-deel Existing
  customers (≤ €1).
- `mix_existing`: Δ gemiddelde CLV = mix + existing per kwartaal; avg nu − een jaar eerder =
  som van vier kwartalen mix + existing.
- `waterfall`: de vier balken = CE eind − CE begin (< €1), kwartaal en jaar.
- `equity_qoq`: het gepubliceerde QoQ-verschil van CE = som van de kwartaalbalken (≤ €1).
- `jaar_netto`: netto aantallen jaarwaterfall sluiten (een jaar eerder + new + reacquired −
  churn = nu; blijvers + churn = een jaar eerder).
- `ce_begin`: CE aan het begin (met de parameters van het begin) = CE van het vorige
  kwartaal (≤ €1).
- `driver_a`: CE = actief × gemiddelde CLV (≤ €1).
- `driver_c`: gemiddelde CLV = Expected invoices × Margin per future invoice.
- `parameters`: alle verwachte segmenten per kwartaaleinde vanaf first_param_quarter.
- `parameters_run`: de laatste complete schatting hoort bij de laatste lading, is
  geconvergeerd en heeft de gekozen segmentatie.
- `derl`: verwacht aantal facturen stijgt met de klantduur en blijft onder Σ δ^t.
- `marge`: marge per abonnement > 0 op elk kwartaaleinde.
- `vorm_getal`: verplichte velden zijn getallen; `vorm_tekst`: de enige tekst is een
  kwartaallabel.
- `volledig`: alle kwartalen vanaf first_dashboard_quarter.
- `afgesloten_kwartaal`: een gepubliceerd kwartaal verandert niet meer (tolerantie één cent,
  1e-9 relatief). Sinds migratie 19 mogen nieuwe velden op het hoogste niveau erbij;
  bestaande velden moeten blijven bestaan met dezelfde waarde.
- `bron`: er is een complete lading.

**Draaien en time-outs**
- Lange runs (refresh_v2_base, publish_v2, estimate_sbg.py) via de Action (met de hand te
  starten) of lokaal met `caffeinate -i`. Een laptop die slaapt verbreekt de verbinding
  terwijl de server klaar is; de transactie wordt dan teruggedraaid.
- Rol ce_loader: statement_timeout 10 min, idle_in_transaction_session_timeout 5 min; de
  functies zetten ook statement_timeout 10 min. Normale duur: refresh_v2_base ±90 s,
  publish_v2 ±50 s.

## Migraties v2 (13–24)
Migraties 1–12 bouwen schema's, ophalen en het CLV-model op; vanaf 13:
- 13 `churn_lever`: hefboom "Every 10% less churn adds …" in yearWaterfall plus controle
  (teruggedraaid in 15).
- 14 `horizon_factor`: publication_v2.horizon_discount_factor (wat €1 over vijf jaar vandaag
  waard is).
- 15 `drop_churn_lever`: churnLever en zijn controle weg.
- 16 `horizon_factor_required`: horizon_discount_factor NOT NULL; publish_v2 stopt bij een
  lege of ongeldige factor.
- 17 `stock_flow`: flows als gebeurtenissen (spell_events), churnRate zuiver, velden
  …Last4Quarters/…Last4VsPrior4, controles stroom_jaar en flows_4kw. quarters_v2 eenmalig
  leeggemaakt.
- 18 `equity_qoq_check`: controle equity_qoq.
- 19 `flow_yoy`: YoY-velden van new, reacquired en churn terug, controle flows_yoy;
  afgesloten_kwartaal staat nieuwe velden op het hoogste niveau toe.
- 20 `mix_split`: mix effect in nieuwkomers en vertrekkers (per kwartaal en vier kwartalen),
  controle mix_delen.
- 21 `own_clv_waterfall`: kwartaalwaterfall met de eigen CLV van klanten, vier balken
  (wf4_json); de balk voor wie kwam en ging uit de waterfall. quarters_v2 eenmalig
  leeggemaakt.
- 22 `year_snapshot`: jaarwaterfall foto tegen foto (mv_bz_year_rows, ververst in
  publish_v2); jaar_som en jaar_som_aantallen weg, jaar_netto erbij. quarters_v2 eenmalig
  leeggemaakt.
- 23 `clv_card_year_snapshot`: YoY-delen van de CLV-kaart foto tegen foto, controles
  clv_yoy_delen en jaar_existing.
- 24 `customer_mix_yoy`: customerMixYoY (som van de twee YoY-delen), controle clv_yoy_mix.
- quarters_v2 is bewust leeggemaakt in 17, 21 en 22 (definitiewijziging, niet de data); dat
  staat telkens in het commentaar van de migratie. Leegmaken alleen met akkoord.

## Scripts
Python-omgeving: `.venv` met scripts/requirements.txt (in de Action:
scripts/requirements-ci.txt).
- `apply_migrations.py`: migraties op Supabase als postgres; met een bestandsnaam alleen die
  migratie plus de beveiligingsasserties, in één transactie.
- `ingest_beanrise.py`: ophalen via de API (ook `--dry-run --max-pages N` als test).
- `estimate_sbg.py`: verversen, schatten, publiceren naar quarters_v2 (`--no-publish`).
- `sbg.py`: het sBG-model (likelihood, fit, convergentie, overleving, segment).
- `validate_holdout.py`: de validatie (`--save` schrijft naar ce_private.validation_runs).
- `test_flow_events.py`: toetst spell_events met verzonnen klantperioden (o.a. twee keer churn
  in één kwartaal); alleen lezen.
- `npm test` (vitest): data- en schermregels op src/data/quarters.json (stroom, waterfalls,
  CLV-kaart, notatie).
- `npm run build` (prebuild haalt de data op) of `npm run fetch-data`: de oude publicatie.
  Voor quarters_v2: `npm run fetch-data:v2` of `npm run dev:v2`.
- Overige scripts in scripts/ zijn uit de eerste opzet, buiten gebruik (load_beanrise.py en
  test_supabase.py stoppen direct) en worden later verwijderd.

## Validatie van het CLV-model
scripts/validate_holdout.py, in de Action op de 1e van de maand (of met de hand). Holdout:
schatten op de data zoals bekend op T (het laatste kwartaaleinde met nog 24 maanden data erna;
schuift dus eens per kwartaal op), vergelijken met de 24 maanden daarna. Beslist wordt op de
foutpercentages. De validatiejob faalt alleen bij een overschreden foutnorm of een fit die niet
convergeert; een gefaalde validatie houdt de publicatie niet tegen.
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
- De app: src/App.tsx met src/components/screen/ (TopBar, SideNav, EquityHero, DriverTiles,
  ClvChangeCard, WaterfallSection, MethodSection, YearChart, ChangeLine); notatie in
  src/lib/format.ts; data en types in src/lib/quarters.ts; CLV-kaart in src/lib/clvChange.ts.
- Niet meer gebruiken (oud ontwerp): antwoordzin en executive summary, verwachte churn,
  Retention-tegel en CLV-retentie op basis van churnpercentages, de oude waterfall
  (aantallen × gemiddelde CLV aan het begin, met mix- en value-effect als balken; jaar als
  som van vier kwartalen), Shapley-decompositie, value/brand/relationship-drivers,
  margeopbouw per order.

## Overige feiten
- Keep-alive: .github/workflows/supabase-keepalive.yml doet twee keer per week een
  leesquery op ce_public (gratis plan pauzeert na 7 dagen zonder activiteit).
  GitHub zet geplande workflows uit na 60 dagen zonder activiteit in de repo.
- Omvang: database ±313 MB (grens gratis plan 500 MB); de dagelijkse lading waarschuwt
  boven 450 MB.
- Node: de versie ligt niet vast in de repo (geen engines, .nvmrc of NODE_VERSION); de
  @supabase-pakketten vragen Node ≥ 22.

## Open punten
- Overstap naar live: proef-v2 naar main, de build op quarters_v2, publicatie omzetten.
- Claude Design bijwerken naar de stand van proef-v2.
- Dagelijkse CLV per klant: alleen wijzigingen opslaan, met de modelversie.
- "Existing customers" opsplitsen in oorzaken: ouder worden (klantduur), herschatting van het
  model, respijt, marge, plan-wissel.
- Opruimen na de overstap: oude tabellen, views en refresh_and_publish(), de scripts uit de
  eerste opzet, ongebruikte velden in quarters_v2 (o.a. …Last4Quarters, …Last4VsPrior4,
  revenueEur, churnRate…),
  en de keep-alive (twee weken na een stabiele dagelijkse run).
- De 60-dagenregel van GitHub voor geplande workflows: nog geen oplossing ingebouwd.
- Na de overstap naar quarters_v2 de v1-resten opruimen: generate_beanrise.py, check_beanrise.py,
  build_quarters.py en de v1-tabellen en -views in ce_private/ce_public.
