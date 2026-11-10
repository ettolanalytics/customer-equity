// Executive summary: vier zinnen met een vaste opbouw (proefversie v2). Alle getallen komen uit
// de data van het gekozen kwartaal (jaarweergave); hier worden alleen woorden gekozen.
import { gb } from './format'
import type { View } from './quarters'

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
  /** Verandering van customer equity t.o.v. een jaar eerder (fractie). */
  g: number
  /** Dezelfde verandering een jaar eerder (opgezocht in kwartaal q−4), of null. */
  gPrev: number | null
  /** Verandering actieve klanten en gemiddelde CLV t.o.v. een jaar eerder (fracties). */
  n: number
  v: number
  /** Mix effect en value effect over de vier kwartalen (euro per klant). */
  mix: number
  val: number
  /** De vijf balken van de jaarwaterfall. */
  parts: SummaryParts
  /** 10% van |churn| van het jaar (uit de data). */
  churnLever: number
}

/** Percentage: hele procenten, bij |x| < 0,5% één decimaal; met of zonder teken. */
export function pct(x: number, signed: boolean): string {
  const abs = Math.abs(x) * 100
  const body = gb.num(abs, abs < 0.5 ? 1 : 0) + '%'
  return signed ? gb.sign(x) + body : body
}

/** Bedrag zonder teken: vanaf €1m in miljoenen met één decimaal, daaronder in duizenden. */
export const amount = (x: number) => gb.eurShort(Math.abs(x))

export function summaryInput(view: View): SummaryInput | null {
  const c = view.current
  const y = c.equityVsYearAgo
  const s = c.yearSummary
  const w = c.yearWaterfall
  if (!y || !s || !w || !c.activeVsYearAgo || !c.avgClvVsYearAgo || w.churnLever === undefined) return null
  return {
    ce1: c.customerEquity,
    g: y.pct,
    gPrev: view.yearAgo?.equityVsYearAgo?.pct ?? null,
    n: c.activeVsYearAgo.pct,
    v: c.avgClvVsYearAgo.pct,
    mix: s.customerMix,
    val: s.existingCustomerValue,
    parts: w.parts,
    churnLever: w.churnLever,
  }
}

/** Welke takken een zin nam (voor tests en rapportage). */
export type Branches = { s1: string; s2: string; r: string; s3: string; c?: string }

export function executiveSummary(i: SummaryInput): { sentences: string[]; branches: Branches } {
  // S1: antwoord en vergelijking met een jaar eerder
  let vPart = ''
  let s1 = 'geen vorig jaar'
  if (i.gPrev !== null) {
    const prev = pct(i.gPrev, true)
    if (i.g > i.gPrev + 0.005) {
      vPart = `, a better result than the year before (${prev})`
      s1 = 'beter'
    } else if (i.g < i.gPrev - 0.005) {
      vPart = `, a weaker result than the year before (${prev})`
      s1 = 'zwakker'
    } else {
      vPart = `, in line with the year before (${prev})`
      s1 = 'gelijk'
    }
  }
  const S1 = `Your customer base is worth ${amount(i.ce1)}, ${pct(i.g, false)} ${i.g >= 0 ? 'more' : 'less'} than a year ago${vPart}.`

  // S2: de twee factoren en de grootste oorzaak binnen de CLV
  const valMain = Math.abs(i.val) >= Math.abs(i.mix)
  const R = valMain
    ? `existing customers became ${i.val >= 0 ? 'more' : 'less'} valuable`
    : `the customers who joined and left were, on average, worth ${i.mix >= 0 ? 'more' : 'less'} than the ones who stayed`
  const r = valMain ? (i.val >= 0 ? 'value +' : 'value −') : i.mix >= 0 ? 'mix +' : 'mix −'
  const n = pct(i.n, true)
  const v = pct(i.v, true)
  let S2: string
  let s2: string
  if (i.n >= 0 && i.v >= 0) {
    S2 = `Both drivers helped: you have more customers (${n}) and they are worth more (average CLV ${v}), mainly because ${R}.`
    s2 = 'beide omhoog'
  } else if (i.n < 0 && i.v < 0) {
    S2 = `Both drivers fell: you have fewer customers (${n}) and they are worth less (average CLV ${v}), mainly because ${R}.`
    s2 = 'beide omlaag'
  } else if (i.n >= 0) {
    S2 = `You have more customers (${n}), but they are worth less (average CLV ${v}), mainly because ${R}.`
    s2 = 'meer klanten, lagere CLV'
  } else {
    S2 = `You have fewer customers (${n}), but they are worth more (average CLV ${v}), mainly because ${R}.`
    s2 = 'minder klanten, hogere CLV'
  }

  // S3: wat het meest remt (het onderdeel met de grootste negatieve waarde)
  const begin = i.g >= 0 ? 'What holds growth back is' : 'What pulls value down most is'
  const keys: (keyof SummaryParts)[] = ['newCustomers', 'reacquiredCustomers', 'churn', 'customerMix', 'existingCustomerValue']
  const worst = keys.map((k) => ({ k, value: i.parts[k] })).reduce((a, b) => (b.value < a.value ? b : a))
  const sentences = [S1, S2]
  const branches: Branches = { s1, s2, r, s3: 'geen negatief onderdeel' }
  if (worst.value < 0) {
    if (worst.k === 'churn') {
      const ratio = Math.abs(i.parts.churn) / i.parts.newCustomers
      const C = ratio >= 1 ? 'more than' : ratio >= 0.75 ? 'almost as much as' : ratio >= 0.5 ? 'more than half of' : 'less than half of'
      sentences.push(`${begin} churn: the customers you lost were worth ${amount(i.parts.churn)}, ${C} the value of new customers added (${amount(i.parts.newCustomers)}).`)
      branches.s3 = 'churn'
      branches.c = C
    } else if (worst.k === 'existingCustomerValue') {
      sentences.push(`${begin} that existing customers became less valuable (${amount(i.parts.existingCustomerValue)}).`)
      branches.s3 = 'value effect'
    } else if (worst.k === 'customerMix') {
      sentences.push(`${begin} the customer mix: the customers who joined and left were, on average, worth less than the ones who stayed (${amount(i.parts.customerMix)}).`)
      branches.s3 = 'mix effect'
    }
    if (branches.s3 !== 'geen negatief onderdeel') branches.s3 = `${branches.s3} (${i.g >= 0 ? 'holds back' : 'pulls down'})`
  }

  // S4: waar ruimte zit
  sentences.push(`Every 10% less churn adds about ${amount(i.churnLever)}.`)
  return { sentences, branches }
}
