// Executive summary (proefversie v2): drie zinnen voor een directeur of investeerder.
//   1. Resultaat: customer equity nu, verandering t.o.v. een jaar eerder, beter/slechter dan het jaar ervoor.
//   2. Verklaring: de twee factoren met hun richting, en de grootste reden voor de CLV-verandering.
//   3. Grootste effect: het onderdeel van de jaarwaterfall met de grootste negatieve waarde.
// Alle getallen komen uit quarters_v2; hier worden alleen woorden gekozen.
//
// Grenzen: maximaal 3 zinnen en 60 woorden; geen oorzaken die niet in de data staan; geen advies.
// De verandering van customer equity staat als bedrag, niet als percentage: zo botst die nooit
// met de afgeronde percentages van klanten en CLV (+6% en +7% is geen +14%).
import { gb } from './format'
import type { View } from './quarters'

// ---------------------------------------------------------------------------
// Drempels (vast; elke vergelijking in de tekst hoort bij één van deze)
// ---------------------------------------------------------------------------
/** S1 "in line with the year before": de verandering verschilt hoogstens 0,5% van de huidige customer equity. */
export const IN_LINE_SHARE = 0.005
/** S1 "about the same as a year ago": de verandering is kleiner dan 0,1% van de huidige customer equity. */
export const FLAT_SHARE = 0.001
/** S2 "held steady": klanten of CLV veranderden minder dan 0,05% (afgerond 0,0%). */
export const STEADY = 0.0005
/** S3 verlies door churn tegenover de waarde van alle instromers, r = |churn| ÷ (new + reacquired). */
export const CHURN_WORDS: { min: number; words: string }[] = [
  { min: 1, words: 'more than' },
  { min: 0.75, words: 'almost as much as' },
  { min: 0.5, words: 'more than half of' },
  { min: 0, words: 'less than half of' },
]

export type SummaryParts = {
  newCustomers: number
  reacquiredCustomers: number
  churn: number
  customerMix: number
  existingCustomerValue: number
}

export type SummaryInput = {
  /** Customer equity van het gekozen kwartaal. */
  ce1: number
  /** Verandering van customer equity t.o.v. een jaar eerder, in euro (equityVsYearAgo.abs). */
  change: number
  /** Dezelfde verandering een jaar eerder (opgezocht in kwartaal q−4), of null. */
  changePrev: number | null
  /** Verandering actieve klanten en gemiddelde CLV t.o.v. een jaar eerder (fracties). */
  n: number
  v: number
  /** Mix effect en value effect over de vier kwartalen (euro per klant). */
  mix: number
  val: number
  /** De vijf balken van de jaarwaterfall. */
  parts: SummaryParts
}

/** Welke takken de zinnen namen (voor tests en rapportage). */
export type Branches = { s1: string; s2: string; r: string; s3: string }

/** Percentage zonder teken: hele procenten, bij |x| < 0,5% één decimaal. */
export function pct(x: number): string {
  const abs = Math.abs(x) * 100
  return gb.num(abs, abs < 0.5 ? 1 : 0) + '%'
}

/** Bedrag zonder teken (CLAUDE.md): vanaf €1m in miljoenen met één decimaal, daaronder in duizenden. */
export const amount = (x: number) => gb.eurShort(Math.abs(x))
/** Bedrag met teken: "+€1.5m", "−€356k". */
export const signedAmount = (x: number) => gb.signedThousands(x)

export function summaryInput(view: View): SummaryInput | null {
  const c = view.current
  const y = c.equityVsYearAgo
  const s = c.yearSummary
  const w = c.yearWaterfall
  if (!y || !s || !w || !c.activeVsYearAgo || !c.avgClvVsYearAgo) return null
  return {
    ce1: c.customerEquity,
    change: y.abs,
    changePrev: view.yearAgo?.equityVsYearAgo?.abs ?? null,
    n: c.activeVsYearAgo.pct,
    v: c.avgClvVsYearAgo.pct,
    mix: s.customerMix,
    val: s.existingCustomerValue,
    parts: w.parts,
  }
}

/** Mix effect in woorden, voor beide groepen: nieuwe klanten en vertrekkers, tegenover de blijvers. */
export const mixReason = (positive: boolean) =>
  positive
    ? 'customers who joined were worth more, or leavers less, than existing customers'
    : 'customers who joined were worth less, or leavers more, than existing customers'

const words = (sentence: string) => sentence.split(/\s+/).filter(Boolean).length
export const wordCount = (sentences: string[]) => sentences.reduce((a, s) => a + words(s), 0)

export function executiveSummary(i: SummaryInput): { sentences: string[]; branches: Branches } {
  // 1. Resultaat
  const flat = Math.abs(i.change) < FLAT_SHARE * i.ce1
  const how = flat
    ? 'about the same as a year ago'
    : `${amount(i.change)} ${i.change >= 0 ? 'more' : 'less'} than a year ago`
  let compare = ''
  let s1 = flat ? 'gelijk aan vorig jaar' : i.change >= 0 ? 'meer' : 'minder'
  if (i.changePrev !== null) {
    const diff = i.change - i.changePrev
    const prev = signedAmount(i.changePrev)
    if (diff > IN_LINE_SHARE * i.ce1) {
      compare = `, better than the year before (${prev})`
      s1 += ', beter'
    } else if (diff < -IN_LINE_SHARE * i.ce1) {
      compare = `, worse than the year before (${prev})`
      s1 += ', zwakker'
    } else {
      compare = `, in line with the year before (${prev})`
      s1 += ', gelijk'
    }
  } else {
    s1 += ', geen vorig jaar'
  }
  const S1 = `Your customer base is worth ${amount(i.ce1)}, ${how}${compare}.`

  // 2. Verklaring: twee factoren met richting, en de grootste reden voor de CLV-verandering.
  const dir = (x: number) => (Math.abs(x) < STEADY ? 0 : x > 0 ? 1 : -1)
  const dn = dir(i.n)
  const dv = dir(i.v)
  const customers = dn === 0 ? 'Customers held steady' : `Customers ${dn > 0 ? 'grew' : 'fell'} ${pct(i.n)}`
  const clv = dv === 0 ? 'average CLV held steady' : `average CLV ${dv > 0 ? 'rose' : 'fell'} ${pct(i.v)}`
  const join = dn !== 0 && dv !== 0 && dn !== dv ? 'but' : 'and'
  // De grootste in absolute zin heeft altijd het teken van de CLV-verandering (mix + value).
  // Mix effect > 0: nieuwe klanten meer waard dan de blijvers en/of vertrekkers minder waard;
  // de zin noemt daarom beide groepen, elk met de juiste richting.
  const valMain = Math.abs(i.val) >= Math.abs(i.mix)
  const R = valMain ? `existing customers became ${i.val >= 0 ? 'more' : 'less'} valuable` : mixReason(i.mix >= 0)
  const S2 =
    dn === 0 && dv === 0
      ? 'Customers and average CLV both held steady.'
      : dv === 0
        ? `${customers} ${join} ${clv}.`
        : `${customers} ${join} ${clv}, mainly because ${R}.`
  const s2 = `${dn > 0 ? 'klanten +' : dn < 0 ? 'klanten −' : 'klanten ='} ${dv > 0 ? 'CLV +' : dv < 0 ? 'CLV −' : 'CLV ='}`
  const r = dv === 0 ? 'geen reden (CLV gelijk)' : valMain ? (i.val >= 0 ? 'value +' : 'value −') : i.mix >= 0 ? 'mix +' : 'mix −'

  // 3. Grootste effect (nog niet besloten; werkt zoals voorheen): het onderdeel met de grootste
  //    negatieve waarde in de jaarwaterfall. Opbouw in elke tak gelijk:
  //    "The largest loss came from {onderdeel} ({bedrag}){aanvulling}."
  const keys: (keyof SummaryParts)[] = ['newCustomers', 'reacquiredCustomers', 'churn', 'customerMix', 'existingCustomerValue']
  const worst = keys.map((k) => ({ k, value: i.parts[k] })).reduce((a, b) => (b.value < a.value ? b : a))
  const sentences = [S1, S2]
  let s3 = 'geen negatief onderdeel'
  if (worst.value < 0) {
    let item = ''
    let tail = ''
    if (worst.k === 'churn') {
      // Vertrokken klanten tegenover alle instromers (new + reacquired), zoals in S2.
      const joined = i.parts.newCustomers + i.parts.reacquiredCustomers
      const ratio = joined > 0 ? Math.abs(i.parts.churn) / joined : Infinity
      const C = CHURN_WORDS.find((t) => ratio >= t.min)!.words
      item = 'customers who left'
      tail = `, ${C} customers who joined (${amount(joined)})`
      s3 = `churn: ${C}`
    } else if (worst.k === 'existingCustomerValue') {
      item = 'existing customers becoming less valuable'
      s3 = 'value effect'
    } else if (worst.k === 'customerMix') {
      const s2Mix = dv !== 0 && !valMain
      // Zelfde naam als op het scherm: "Mix effect".
      item = 'the mix effect'
      if (s2Mix && i.mix < 0) {
        // S2 legde hetzelfde negatieve mix effect al uit: geen herhaling.
        s3 = 'mix effect (al uitgelegd)'
      } else if (s2Mix) {
        // Het bedrag is de som over het jaar van de balken (klanten × mix effect per kwartaal) en is
        // negatief, terwijl het mix effect per klant over het jaar de CLV verhoogde (S2). Beide kloppen:
        // de negatieve kwartalen hadden meer klanten. De zin noemt dat verschil, geen kwartalen.
        tail = ', although it raised average CLV over the year'
        s3 = 'mix effect (balk −, CLV +)'
      } else {
        tail = `: ${mixReason(false)}`
        s3 = 'mix effect'
      }
    }
    // Stabiele CLV maar een verlies in value of mix effect: dan compenseerde het andere effect het.
    const other = worst.k === 'existingCustomerValue' ? i.parts.customerMix : worst.k === 'customerMix' ? i.parts.existingCustomerValue : 0
    if (dv === 0 && other > 0) {
      tail += `, offset by ${worst.k === 'existingCustomerValue' ? 'the mix effect' : 'existing customers becoming more valuable'} (${amount(other)})`
      s3 += ', gecompenseerd'
    }
    sentences.push(`The largest loss came from ${item} (${amount(worst.value)})${tail}.`)
  }
  return { sentences, branches: { s1, s2, r, s3 } }
}
