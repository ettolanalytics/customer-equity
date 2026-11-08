interface DefinitionsProps {
  discountRate: string
  refreshedAt: string
  isSampleData: boolean
}

export function Definitions({ discountRate, refreshedAt, isSampleData }: DefinitionsProps) {
  const items: [term: string, description: string][] = [
    ['Actieve klant', '≥1 niet-volledig-geretourneerde order in de laatste 12 mnd. Bron: orderdatabase.'],
    [
      'Retentie',
      'aandeel actieve klanten van vorig jaar dat dit jaar opnieuw actief is. Churn = 1 − retentie.',
    ],
    [
      'Contributiemarge',
      'netto-omzet na retouren minus inkoop, verzending, betaalkosten en directe marketing, per actieve klant per jaar. Bron: ERP.',
    ],
    [
      'CLV',
      `m × r / (1 + d − r). Aanname: constante marge en retentie, oneindige horizon, discontovoet d = ${discountRate}.`,
    ],
    [
      'Shapley-decompositie',
      'CE = N × m × r / (1 + d − r). Elke driver (N, m, r) krijgt zijn gemiddelde marginale bijdrage over alle 3! = 6 volgordes.',
    ],
    [
      'Branded search',
      'klikken op zoektermen met de merknaam. Bron: Search Console (eigen property). Proxy voor merkvoorkeur.',
    ],
    [
      'Referral-aandeel',
      'nieuwe klanten met een gebruikte referralcode. Onderschat mond-tot-mondreclame zonder code.',
    ],
    [
      'Geen samengestelde scores',
      'drivers worden niet tot één index gewogen; er is geen gevalideerde weging.',
    ],
    [
      'Data',
      `${isSampleData ? 'fictieve voorbeelddata, onderling consistent. ' : ''}Laatste verversing: ${refreshedAt}.`,
    ],
  ]

  return (
    <section className="card" aria-labelledby="definitions-title">
      <h2 id="definitions-title" className="eyebrow">
        Definities, bronnen en aannames
      </h2>
      <dl className="definitions">
        {items.map(([term, description]) => (
          <div key={term}>
            <dt>{term}</dt> <dd>— {description}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
