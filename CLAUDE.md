# Customer Equity-dashboard

## Doel
Eén scherm dat beantwoordt: "Is your customer base worth more than a year ago?"
Gebouwd op echte openbare data (KKBox), volgens het ontwerp uit Claude Design.

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
- Bron: KKBox Churn Prediction Challenge (Kaggle, WSDM 2018).
- Bestanden: data/raw/transactions.parquet, transactions_v2.parquet, members_v3.parquet.
- data/raw/ staat in .gitignore en gaat nooit naar GitHub.
- Ruwe periode: 1 jan 2015 – 31 mrt 2017.
- Dashboardperiode: Q2 2015 – Q4 2016. Huidig kwartaal = Q4 2016.
  (Q1 2015: iedereen lijkt nieuw. Q1 2017: churn niet vast te stellen, data stopt
  voor het einde van de 30 dagen respijt.)
- Opschonen: dubbele regels tussen v1 en v2 verwijderen; vervaldatums vóór 2015
  of na 2019 eruit.
- Betaalmethode 39: klanten die ooit methode 39 gebruikten, worden helemaal
  weggelaten (alle transacties van die klant). Reden: storing in Q2 2016, gevolgd
  door een massale heractivering op 31 juli 2016.
- Klant worden: iemand wordt klant op de datum van zijn eerste betaalde
  abonnement (is_cancel = 0, payment_plan_days ≥ 30, actual_amount_paid > 0).
  Transacties vóór die datum tellen niet mee. Daarna tellen alle transacties mee
  voor de vraag of iemand actief is, ook gratis maanden. Klanten zonder zo'n
  betaald abonnement tellen nergens mee.
- Beide besluiten gaan vóór alle andere berekeningen (ook omzet).

## Vaste aannames (in het rekenscript, niet instelbaar in de app)
- Contributiemarge: 30% van actual_amount_paid (alleen is_cancel = 0)
  (onderbouwing: Spotify Premium-brutomarge 29–34% in 2023–2025).
- Valuta: euro. 1 EUR = 35,14 TWD (gemiddelde jaarkoers 2015–2017, ValutaFX).
- Discontovoet: 10% per jaar.
- CLV-horizon: maximaal 20 kwartalen (5 jaar).

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
- Omzet: actual_amount_paid, alleen uit regels met is_cancel = 0.
- Marge per klant per kwartaal: omzet in euro × 30%.
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

Jaar (bijv. Q4 2015 → Q4 2016):
- + nieuwe klanten (som van de vier kwartalen) × V0
- + reacquired klanten (som) × V0
- − werkelijke churn (som) × V0
- ± marge-effect en ± retentie-effect (zie onder)

Kwartaal (bijv. Q3 2016 → Q4 2016):
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
Kwartalen zonder verwachte churn (geen vorig jaar: Q2 2015 – Q1 2016) krijgen
geen waterfall: de velden zijn null.
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
4 kwartalen; hoort bij de CLV. Het rekenscript controleert per kwartaal dat deze
drie verbanden exact kloppen (afwijking > €1 of > 0 klanten: stoppen en melden).
Elke tegel: waarde, vergelijking met vorig kwartaal en een jaar eerder,
minigrafiek, gedeelde hover over alle grafieken.

## Schermteksten
Afwijkingen van en aanvullingen op de teksten in het ontwerp:
1. Antwoordzin: acquisition en CLV over de laatste vier kwartalen. Het
   churndeel over de kwartalen met verwachte churn, en het aantal kwartalen staat
   in de zin. Na de eerste zin over customer equity volgen twee zinnen:
   "Over the last four quarters: X acquired customers (Y new, Z reacquired), and
   average CLV fell/rose by €W. Over the last three quarters, Z fewer/more
   customers churned than expected."
2. Rekenvoorbeeld "How we calculate": rekent met `retention` uit de JSON. Tekst:
   "Assuming x% churn per quarter (average of the previous four quarters)".
3. Gestippelde lijn verwachte churn: alleen waar een waarde is. In de hovertekst
   "Expected —" bij kwartalen zonder waarde.
4. Tegels New en Reacquired staan los (er is geen aparte Acquisition-tegel meer;
   acquisition = new + reacquired staat in de antwoordzin). Tooltip Reacquired:
   "Customers who churned earlier (more than 30 days without a subscription) and
   came back." Tooltip Retention: "Average churn of the previous four quarters,
   used to calculate CLV. Differs from this quarter's churn." De Churn-tegel
   houdt de gestippelde lijn voor verwachte churn ("Expected —" in de hover
   waar geen waarde is).
   Waterfall-labels: "New customers", "Reacquired customers", "Churn" (jaar) of
   "Expected churn" en "Lower/Higher churn than expected" (kwartaal), "Lower/Higher
   margin per customer", "Lower/Higher retention". Toelichting bij marge bijv.
   "Margin per customer €3.67 → €3.18 per quarter × 1,108,028 customers."
   Toggle Year / Quarter rechtsboven op de waterfall-kaart; periodelabel en titel
   veranderen mee.
   How we calculate, stap 3: noemt new en reacquired en de splitsing in marge-
   en retentie-effect.
5. Actieve klant: "An active customer is a customer with a running subscription,
   or within 30 days after it expired."
6. Header: bedrijfsnaam "KKBox (public dataset)", initialen "LJ". Met de
   kwartaalknop kies je Q2, Q3 of Q4 2016: alleen kwartalen waarvoor het hele
   scherm gevuld is (vergelijking met vorig jaar, antwoordzin en waterfall).
   Standaard Q4 2016. Grafieken lopen tot en met het gekozen kwartaal, dat dan
   het "huidige" kwartaal is. De Export-knop opent het
   afdrukvenster van de browser, waarin de gebruiker "Opslaan als PDF" kiest.
   Afdrukopmaak: A4 liggend, zonder zijbalk en knoppen.
7. Alle CLV-bedragen met twee decimalen (bijv. €21.70), ook in de antwoordzin en
   onder de lijngrafiek. Customer equity blijft in miljoenen.

## Code
- Een los rekenscript maakt de kwartaalcijfers en schrijft ze naar een JSON-bestand.
  De React-app leest dat bestand en rekent zelf niets.
- Supabase komt pas als de cijfers kloppen. Bestaande migraties moeten dan worden
  aangepast aan deze datavorm.
- Hergebruiken: Vite/React-basis, src/lib/format.ts, src/lib/supabase.ts.
- Niet meer gebruiken: Shapley-decompositie, value/brand/relationship-drivers,
  margeopbouw per order (oud ontwerp).
