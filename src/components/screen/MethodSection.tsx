// "How we calculate": vijf stappen en het rekenvoorbeeld (CLAUDE.md, Schermteksten 4 en 5; ontwerp v3.4 §9).
import { gb } from '../../lib/format'
import { assumptions as a, type Quarter, type View } from '../../lib/quarters'

/** Percentage zonder decimalen: 0.1 → "10%" */
const pct0 = (fraction: number) => gb.num(fraction * 100) + '%'

const steps = (current: Quarter) => {
  const ex = current.clvExample
  const years = gb.num(a.horizonMonths / 12)
  const perPlan = current.model.some((m) => m.segment > 0)
  const group = perPlan ? 'per plan the customer started on (returning customers separately),' : 'on all customers together,'
  return [
    {
      title: 'CLV',
      text: `The value of an active customer: the contribution margin (price minus the cost of each delivery, excluding VAT, averaged over the last 12 months per plan, including expected up- and downgrades) we expect from them over the next ${years} years (${gb.num(a.horizonMonths)} monthly invoices), discounted to today at ${pct0(a.discountRateYear)} per year. It counts only what is left to earn from current customers, not acquisition costs, and nothing after ${years} years. How long a customer is expected to stay comes from a shifted-beta-geometric model: every customer has their own chance of cancelling, customers who have stayed longer are more likely to stay, and the model is fitted ${group} on all subscriptions up to the quarter.`,
      example:
        `A new ${gb.plan(ex.sizeGrams)} customer renews next month with a ${gb.pct(ex.nextInvoiceChance)} chance and is expected to pay ` +
        `${gb.num(ex.expectedInvoices, 1)} more invoices within ${years} years (discounted; ${gb.num(ex.undiscountedInvoices, 1)} undiscounted). ` +
        `At ${gb.clv(ex.marginPerInvoice)} margin per invoice, plus expected plan changes, that is a CLV of ${gb.clv(ex.value)}.`,
    },
    {
      title: 'Customer equity',
      text: `The sum of the CLV of all active customers: active customers × average CLV. An active customer is a customer with a running subscription, or within ${a.graceDays} days after it expired. Customers in those ${a.graceDays} days count at the share that still renews (${gb.pct(current.lateRenewalFactor)}).`,
    },
    {
      title: 'Why average CLV changes',
      text: `Customer mix: different customers joined and left (new customers are not yet expected to stay as long). Existing customer value: customers who stayed became more or less valuable. Together they are the change in average CLV. Average CLV = ${gb.num(current.expectedInvoices, 1)} expected invoices × ${gb.clv(current.marginPerFutureInvoice)} margin per future invoice.`,
    },
    {
      title: 'Change per quarter',
      text: 'New, reacquired and churned customers are valued at the average CLV at the start of the period; customer mix and existing customer value are multiplied by the number of customers at the end. The year view adds up the four quarters.',
    },
    {
      title: 'Acquisition costs',
      text: 'Acquisition costs are not included. Amounts exclude VAT.',
    },
  ] as { title: string; text: string; example?: string }[]
}

export function MethodSection({ view }: { view: View }) {
  return (
    <section id="method" className="card section" aria-label="How we calculate">
      <h2 className="section-title" style={{ marginBottom: 6 }}>How we calculate</h2>
      <ol className="method">
        {steps(view.current).map((s, i) => (
          <li key={s.title}>
            <span className="method-n">{i + 1}</span>
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <p className="method-title">{s.title}</p>
              <p className="method-text">{s.text}</p>
              {s.example && (
                <p className="method-ex">
                  <span style={{ fontWeight: 600 }}>Worked example: </span>
                  {s.example}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
