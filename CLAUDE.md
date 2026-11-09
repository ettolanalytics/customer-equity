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
- Omzet: actual_amount_paid, alleen uit regels met is_cancel = 0.
- Marge per klant per kwartaal: omzet in euro × 30%.
- CLV: marge per kwartaal × verwachte duur als klant (max. 20 kwartalen),
  verdisconteerd tegen 10% per jaar.
- CLV-retentie per kwartaal = 1 − gemiddeld churnpercentage van de vorige
  4 kwartalen. Zijn er minder dan 4, het gemiddelde van de kwartalen die er zijn.
- Customer equity: actieve klanten × gemiddelde CLV.
- Acquisitiekosten tellen niet mee.

## Verklaring van de verandering (waterfall)
Per kwartaal, tegen de gemiddelde CLV aan het begin van het kwartaal:
- + nieuwe klanten × CLV. Nieuwe klanten in de waterfall en de Acquisition-tegel
  = nieuw + terug, volgens het design (eind − begin + churn). In de JSON blijven
  nieuw en terug als losse velden staan.
- − verwachte churn × CLV
- ± (verwachte − werkelijke churn) × CLV
- ± verandering gemiddelde CLV × klanten aan eind kwartaal
Kwartalen zonder verwachte churn (geen vorig jaar: Q2 2015 – Q1 2016) krijgen
geen waterfall: het veld waterfall is null.
De onderdelen moeten exact optellen tot de verandering in customer equity.
Dit wordt in code gecontroleerd. Sluit het niet (bijv. door terugkerende klanten),
dan melden en niet stilletjes wegpoetsen.

## Code
- Een los rekenscript maakt de kwartaalcijfers en schrijft ze naar een JSON-bestand.
  De React-app leest dat bestand en rekent zelf niets.
- Supabase komt pas als de cijfers kloppen. Bestaande migraties moeten dan worden
  aangepast aan deze datavorm.
- Hergebruiken: Vite/React-basis, src/lib/format.ts, src/lib/supabase.ts.
- Niet meer gebruiken: Shapley-decompositie, value/brand/relationship-drivers,
  margeopbouw per order (oud ontwerp).
