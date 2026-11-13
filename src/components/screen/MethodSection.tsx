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
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  const yearsWord = WORDS[a.horizonMonths / 12] ?? years
  const perPlan = c.model.some((m) => m.segment > 0)
  const returning = c.model.some((m) => m.segment === 0)
  // Hoe het sBG-model is geschat, uit de parameters in de data (per startabonnement en/of terugkeerders apart).
  const fitted = perPlan
    ? `fitted per starting plan${returning ? ' and separately for returning customers' : ''}, on all subscriptions up to the quarter`
    : `fitted on all customers together${returning ? ' and separately for returning customers' : ''}, on all subscriptions up to the quarter`

  const intro = `A customer’s CLV is the margin we expect them to bring in over the next ${years} years, counted in today’s euros. It combines three things:`
  const model: [string, string][] = [
    [
      'How long the customer stays.',
      'Every customer has their own chance of cancelling each month, and these chances differ between customers. ' +
        'Customers who cancel easily tend to leave early, so the longer a customer has stayed, the more likely they are to stay. ' +
        `This is the shifted-beta-geometric model, ${fitted}.`,
    ],
    ['What each invoice earns.', 'The margin per invoice for the customer’s plan, including expected up- and downgrades.'],
    ['When it comes in.', `Margin further in the future counts for less: ${pct0(a.discountRateYear)} per year.`],
  ]
  const example =
    `a new ${gb.plan(ex.sizeGrams)} customer renews next month with a ${gb.pct(ex.nextInvoiceChance)} chance. ` +
    `Over ${years} years they are expected to pay ${gb.num(ex.expectedInvoices, 1)} more invoices, counted in today’s euros. ` +
    `At ${gb.clv(ex.marginPerInvoice)} margin per invoice, plus expected plan changes, their CLV is ${gb.clv(ex.value)}.`
  const rows: [string, string][] = [
    ['Horizon', `${years} years (${gb.num(a.horizonMonths)} monthly invoices); nothing after ${years} years counts.`],
    ['Future margin in today\'s euros', `${pct0(a.discountRateYear)} per year — €1 in ${yearsWord} years counts as ${gb.clv(a.horizonDiscountFactor)} today.`],
    ['Margin', 'Price minus the cost of each delivery, excluding VAT; averaged over the last 12 months per plan; including expected up- and downgrades.'],
    ['Active customer', `Running subscription, or within ${a.graceDays} days after it expired.`],
    [`Customers within those ${a.graceDays} days`, `Count at the share that still renews (${gb.pct(c.lateRenewalFactor)}).`],
    [
      'When measured',
      'Active customers, average CLV and customer equity: on the last day of the quarter. New, reacquired and churn: all events during the quarter.',
    ],
    ['Acquisition costs', 'Not included.'],
    ['Change per period', 'New, reacquired and churned customers at the average CLV at the start; mix and value effect × customers at the end; the year adds up four quarters.'],
  ]

  return (
    <section id="method" className="card section" aria-label="Model and assumptions">
      <h2 className="section-title" style={{ marginBottom: 6 }}>Model and assumptions</h2>
      <div className="ma">
        <div className="ma-block">
          <p className="method-title">CLV model</p>
          <p className="ma-intro">{intro}</p>
          <ol className="ma-list">
            {model.map(([head, text]) => (
              <li key={head}>
                <span style={{ fontWeight: 600, color: '#111110' }}>{head}</span> {text}
              </li>
            ))}
          </ol>
          <p className="method-ex">
            <span style={{ fontWeight: 600 }}>Example: </span>
            {example}
          </p>
          {/* Voorlopig, tot vaststaat of dit klopt. */}
          <p className="ma-intro">Checked every month against what actually happened next.</p>
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
