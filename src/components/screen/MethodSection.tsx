// "Model and assumptions" (proefversie v2): het model in het kort en de aannames als tabel.
// De definities staan in de tooltips. Alle getallen komen uit de data (quarters_v2, publication_v2).
import { gb } from '../../lib/format'
import { assumptions as a, type View } from '../../lib/quarters'

/** Percentage zonder decimalen: 0.1 → "10%" */
const pct0 = (fraction: number) => gb.num(fraction * 100) + '%'

export function MethodSection({ view }: { view: View }) {
  const c = view.current
  const ex = c.clvExample
  const years = gb.num(a.horizonMonths / 12)
  const perPlan = c.model.some((m) => m.segment > 0)
  const returning = c.model.some((m) => m.segment === 0)
  const fitted = perPlan
    ? `Fitted per starting plan${returning ? ', with returning customers separately,' : ''} on all subscriptions up to the quarter.`
    : `Fitted on all customers together${returning ? ', with returning customers separately,' : ''} on all subscriptions up to the quarter.`

  const model = [
    'How long customers stay: shifted-beta-geometric model. Every customer has their own chance of cancelling; customers who have stayed longer are more likely to stay.',
    fitted,
    'Checked every month against what actually happened next.',
  ]
  const example =
    `A new ${gb.plan(ex.sizeGrams)} customer renews next month with a ${gb.pct(ex.nextInvoiceChance)} chance and is expected to pay ` +
    `${gb.num(ex.expectedInvoices, 1)} more invoices within ${years} years (discounted). ` +
    `At ${gb.clv(ex.marginPerInvoice)} margin per invoice, plus expected plan changes, that is a CLV of ${gb.clv(ex.value)}.`
  const rows: [string, string][] = [
    ['Horizon', `${years} years (${gb.num(a.horizonMonths)} monthly invoices); nothing after ${years} years counts.`],
    ['Discount rate', `${pct0(a.discountRateYear)} per year.`],
    ['Margin', 'Price minus the cost of each delivery, excluding VAT; averaged over the last 12 months per plan; including expected up- and downgrades.'],
    ['Active customer', `Running subscription, or within ${a.graceDays} days after it expired.`],
    [`Customers within those ${a.graceDays} days`, `Count at the share that still renews (${gb.pct(c.lateRenewalFactor)}).`],
    ['Acquisition costs', 'Not included.'],
    ['Change per period', 'New, reacquired and churned customers at the average CLV at the start; mix and value effect × customers at the end; the year adds up four quarters.'],
  ]

  return (
    <section id="method" className="card section" aria-label="Model and assumptions">
      <h2 className="section-title" style={{ marginBottom: 6 }}>Model and assumptions</h2>
      <div className="ma">
        <div className="ma-block">
          <p className="method-title">Model</p>
          <ul className="ma-list">
            {model.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="method-ex">
            <span style={{ fontWeight: 600 }}>Example: </span>
            {example}
          </p>
        </div>
        <div className="ma-block">
          <p className="method-title">Assumptions</p>
          <table className="ma-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
