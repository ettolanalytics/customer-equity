// Haalt de gepubliceerde kwartaalcijfers en aannames uit Supabase (ce_public) en
// schrijft ze naar src/data/quarters.json: { assumptions, quarters }.
// Draait vóór elke build (npm "prebuild"). Lukt het niet, dan stopt de build met een
// melding; er wordt nooit teruggevallen op oude data.
//
// Nodig: SUPABASE_URL en SUPABASE_PUBLISHABLE_KEY (Netlify: omgevingsvariabelen;
// lokaal: .env.local, waar ook de VITE_-namen worden geaccepteerd).
//
// Proefversie (branch proef-v2, alleen lokaal): CE_DATA=v2 leest ce_public.quarters_v2 en
// publication_v2 (sBG-model, nog niet live). Zonder CE_DATA verandert er niets.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = `${ROOT}src/data/quarters.json`
const TIMEOUT_MS = 20_000
const V2 = process.env.CE_DATA === 'v2'

// Sleutels van het type Quarter in de proefversie (ce_public.quarters_v2).
const QUARTER_KEYS_V2 = [
  'label', 'activeBegin', 'activeEnd', 'newCustomers', 'reacquiredCustomers', 'acquiredCustomers',
  'churn', 'churnRate', 'revenueEur', 'customerEquity', 'avgClv', 'avgClvChange', 'customerMix',
  'existingCustomerValue', 'expectedInvoices', 'marginPerFutureInvoice', 'lateRenewalFactor', 'model',
  'clvExample', 'equityVsPrevQuarter', 'equityVsYearAgo', 'activeVsPrevQuarter', 'activeVsYearAgo',
  'avgClvVsPrevQuarter', 'avgClvVsYearAgo', 'newVsPrevQuarter', 'newVsYearAgo', 'reacquiredVsPrevQuarter',
  'reacquiredVsYearAgo', 'churnVsPrevQuarter', 'churnVsYearAgo', 'churnRateVsPrevQuarter', 'churnRateVsYearAgo',
  'customerMixVsPrevQuarter', 'customerMixVsYearAgo', 'existingCustomerValueVsPrevQuarter',
  'existingCustomerValueVsYearAgo', 'yearSummary', 'waterfall', 'yearWaterfall',
].sort()

// Sleutels van het type Quarter in src/lib/quarters.ts (ook gecontroleerd in SQL).
const QUARTER_KEYS = [
  'label', 'activeBegin', 'activeEnd', 'newCustomers', 'reacquiredCustomers', 'acquiredCustomers',
  'churn', 'expectedChurn', 'churnRate', 'expectedChurnRate', 'churnRateVsExpected', 'revenueEur',
  'marginPerCustomer', 'retention', 'retentionQuarters', 'avgClv', 'customerEquity',
  'equityVsPrevQuarter', 'equityVsYearAgo', 'acquiredVsPrevQuarter', 'acquiredVsYearAgo',
  'churnRateVsPrevQuarter', 'churnRateVsYearAgo', 'avgClvVsPrevQuarter', 'avgClvVsYearAgo',
  'activeVsPrevQuarter', 'activeVsYearAgo', 'newVsPrevQuarter', 'newVsYearAgo',
  'reacquiredVsPrevQuarter', 'reacquiredVsYearAgo', 'churnVsPrevQuarter', 'churnVsYearAgo',
  'marginVsPrevQuarter', 'marginVsYearAgo', 'retentionVsPrevQuarter', 'retentionVsYearAgo',
  'churnVsExpectedCount', 'yearSummary', 'clvExample', 'waterfall', 'yearWaterfall',
].sort()

function fail(message, hint) {
  console.error(`\n✖ Kwartaalcijfers ophalen uit Supabase mislukt: ${message}`)
  if (hint) console.error(`  ${hint}`)
  console.error('  De build stopt; er wordt geen oude data gebruikt.\n')
  process.exit(1)
}

if (existsSync(`${ROOT}.env.local`)) process.loadEnvFile(`${ROOT}.env.local`)
const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.replace(/\/+$/, '')
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
if (!url || !key) {
  fail('SUPABASE_URL of SUPABASE_PUBLISHABLE_KEY ontbreekt.',
    'Netlify: Site configuration → Environment variables. Lokaal: .env.local.')
}

async function get(table, query) {
  let res
  try {
    res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: { apikey: key, 'Accept-Profile': 'ce_public', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    fail(`${table}: Supabase antwoordt niet (${e.cause?.code ?? e.name}: ${e.message}).`,
      'Is het project gepauzeerd? Herstel het in het Supabase-dashboard en start de build opnieuw.')
  }
  const body = await res.text()
  if (!res.ok) {
    const hint = res.status >= 500
      ? 'Supabase is (tijdelijk) niet beschikbaar of gepauzeerd. Controleer het dashboard.'
      : body.includes('schema') ? 'Staat ce_public in Settings → API → Exposed schemas?' : undefined
    fail(`${table}: HTTP ${res.status} ${body.slice(0, 300)}`, hint)
  }
  try { return JSON.parse(body) } catch { fail(`${table}: geen geldige JSON.`) }
}

const [pubRows, rows] = await Promise.all([
  get(V2 ? 'publication_v2' : 'publication', 'select=*'),
  get(V2 ? 'quarters_v2' : 'quarters', 'select=seq,label,data&order=seq.asc'),
])

// Controles op wat we binnenkrijgen
if (pubRows.length !== 1) fail(`publication heeft ${pubRows.length} rijen, verwacht 1. Is de refresh gedraaid?`)
const p = pubRows[0]
if (rows.length === 0 || rows.length !== p.quarter_count) {
  fail(`${rows.length} kwartalen ontvangen, publication zegt ${p.quarter_count}.`)
}
rows.forEach((r, i) => {
  if (r.seq !== i + 1 || r.data?.label !== r.label) fail(`kwartaal ${r.label}: volgorde of label klopt niet.`)
  const keys = Object.keys(r.data).sort()
  if (keys.join() !== (V2 ? QUARTER_KEYS_V2 : QUARTER_KEYS).join()) fail(`kwartaal ${r.label}: velden wijken af van het type Quarter.`)
})
if (rows.at(-1).label !== p.last_quarter) fail(`laatste kwartaal ${rows.at(-1).label}, publication zegt ${p.last_quarter}.`)
if (!rows.some((r) => r.label === p.first_selectable)) fail(`kiesbaar kwartaal ${p.first_selectable} ontbreekt.`)

const out = V2 ? {
  assumptions: {
    discountRateYear: Number(p.discount_rate_year),
    horizonMonths: Number(p.horizon_months),
    horizonDiscountFactor: Number(p.horizon_discount_factor),
    graceDays: Number(p.grace_days),
    asOf: p.as_of,
    generatedAt: p.generated_at,
    firstSelectable: p.first_selectable,
    lastQuarter: p.last_quarter,
    plans: p.plans,
  },
  quarters: rows.map((r) => r.data),
} : {
  assumptions: {
    discountRateYear: Number(p.discount_rate_year),
    horizonQuarters: Number(p.horizon_quarters),
    graceDays: Number(p.grace_days),
    priceEur: Number(p.price_eur),
    costPerInvoiceEur: Number(p.cost_per_invoice_eur),
    marginPerInvoiceEur: Number(p.margin_per_invoice_eur),
    generatedAt: p.generated_at,
    firstSelectable: p.first_selectable,
    lastQuarter: p.last_quarter,
  },
  quarters: rows.map((r) => r.data),
}
mkdirSync(dirname(OUT), { recursive: true }) // src/data/ bestaat niet in een verse clone
writeFileSync(`${OUT}.tmp`, JSON.stringify(out, null, 2) + '\n')
renameSync(`${OUT}.tmp`, OUT)
console.log(`✓ ${V2 ? '[v2] ' : ''}${rows.length} kwartalen (${rows[0].label} – ${p.last_quarter}) uit Supabase, gemaakt ${p.generated_at}.`)
