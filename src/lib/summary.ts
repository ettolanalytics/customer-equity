// Executive summary (proefversie v2): drie zinnen, uitgelegd zoals aan een directeur aan tafel.
//   1. Resultaat: wat de klantenbasis nu waard is, de verandering t.o.v. een jaar eerder, en hoe die
//      zich verhoudt tot de verandering het jaar daarvoor.
//   2. Verklaring: klanten en gemiddelde CLV met hun richting. Bij een CLV-verandering van minstens
//      SMALL_CLV ook waarom, met het bedrag per klant; daaronder alleen "barely changed".
//   3. Grootste verlies: het eenduidige onderdeel van de jaarverandering met de grootste negatieve
//      waarde, in gewone woorden. Heeft S2 het al uitgelegd, dan verwijst S3 er kort naar.
// Alle getallen komen uit quarters_v2; hier worden alleen woorden gekozen. Geen oorzaken die niet
// in de data staan, geen advies. Vaktermen alleen "customer equity" en "CLV"; dus niet "mix effect",
// "value effect", "drivers" of "waterfall". Zo kort als kan, zo lang als nodig (geen woordgrens).
//
// Drempels (alle hieronder als benoemde constante):
//   * SMALL_CLV: is de CLV-verandering over het jaar kleiner dan 1% (in absolute zin), dan noemt S2
//     geen redenen, alleen "average CLV barely changed (+€1.74 per customer)".
//   * OFFSET_SHARE (10%): een tweede reden die mee- of tegenwerkt staat er alleen bij als die minstens
//     10% van de eerste reden is (in euro per klant). Dat geldt op twee plekken:
//       - in S2 tussen de twee redenen van de CLV-verandering (bestaande klanten, wie kwam en ging):
//         de kleinere reden staat erbij ("although existing customers became less valuable") als die
//         de andere kant op ging en minstens 10% van de grootste is;
//       - binnen wie kwam en ging, tussen nieuwkomers en vertrekkers: het kleinere deel staat erbij,
//         zonder bedrag, met wat het deed met het grootste deel ("that leavers were worth less too
//         softened this a little") als het minstens 10% van het grootste deel is. Alleen als wie kwam
//         en ging de hoofdreden is of het grootste verlies in S3; als tegenwerkende reden in S2 staat
//         alleen het grootste deel er.
//     Daaronder valt de kleinere reden weg: die verandert het beeld niet.
//   * SECOND_WORDS: hoe sterk het kleinere deel van wie kwam en ging het grootste versterkte of
//     verzachtte (aandeel = kleinste ÷ grootste, in euro per klant).
//
// Tekens: een bedrag met teken staat alleen naast een woord met dezelfde richting ("worth less (−€1.50)",
// "more valuable (+€27.89)"). Vertrekkers die minder waard waren verhogen de CLV; daar staat het bedrag
// als gevolg: "leavers were worth less than the customers who stayed, which raised average CLV by €25.48".
// Nieuwkomers en vertrekkers heten samen "the shift in who joined and who left" of "newcomers and
// leavers", nooit "the customers who joined and left" (geen groep klanten).
//   * IN_LINE_SHARE, FLAT_SHARE (S1) en STEADY (klanten in S2): zie hieronder.
//   * CHURN_WORDS: hoe het verlies door vertrekkers zich verhoudt tot wat binnenkwam (S3).
//
// S3 kiest alleen een eenduidig onderdeel: een onderdeel waarvan het jaarbedrag in euro een andere
// richting heeft dan het effect per klant over het jaar (dat kan, omdat kwartalen met meer klanten
// zwaarder wegen) wordt niet als grootste verlies aangewezen. Is er geen eenduidig negatief onderdeel,
// dan vervalt S3.
import { gb } from './format'
import type { View } from './quarters'

// ---------------------------------------------------------------------------
// Drempels (vast; elke vergelijking in de tekst hoort bij één van deze)
// ---------------------------------------------------------------------------
/** S1 "about the same … as the year before": de verandering verschilt hoogstens 0,5% van de huidige customer equity. */
export const IN_LINE_SHARE = 0.005
/** S1 "about the same as a year ago": de verandering is kleiner dan 0,1% van de huidige customer equity. */
export const FLAT_SHARE = 0.001
/** S2 "Customers held steady": het aantal klanten veranderde minder dan 0,05% (afgerond 0,0%). */
export const STEADY = 0.0005
/** S2 "average CLV barely changed", zonder redenen: de CLV veranderde minder dan 1% (in absolute zin). */
export const SMALL_CLV = 0.01
/** Een tweede reden staat erbij als die minstens 10% van de eerste is (zie de uitleg bovenaan). */
export const OFFSET_SHARE = 0.1
/** Wat het kleinere deel van wie kwam en ging deed met het grootste, naar aandeel (kleinste ÷ grootste). */
export const SECOND_WORDS = {
  strengthened: [
    { below: 0.5, words: 'strengthened this a little' },
    { below: Infinity, words: 'strengthened this' },
  ],
  softened: [
    { below: 0.5, words: 'softened this a little' },
    { below: 0.75, words: 'softened this' },
    { below: Infinity, words: 'largely offset this' },
  ],
}
/** S3 verlies door vertrekkers tegenover wat nieuwe en terugkerende klanten opleverden, r = |churn| ÷ (new + reacquired). */
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
  /** Verandering van de gemiddelde CLV t.o.v. een jaar eerder, in euro per klant (avgClvVsYearAgo.abs). */
  vAbs: number
  /** Bijdragen aan die verandering over de vier kwartalen (euro per klant): wie kwam en ging (mix), en
   *  bestaande klanten (val). mix = mixIn (nieuwkomers) + mixOut (vertrekkers), t.o.v. de blijvers. */
  mix: number
  mixIn: number
  mixOut: number
  val: number
  /** De vijf onderdelen van de jaarverandering van customer equity (euro). */
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

export function summaryInput(view: View): SummaryInput | null {
  const c = view.current
  const y = c.equityVsYearAgo
  const s = c.yearSummary
  const w = c.yearWaterfall
  const mixIn = c.customerMixNewcomersLast4Quarters
  const mixOut = c.customerMixLeaversLast4Quarters
  if (!y || !s || !w || !c.activeVsYearAgo || !c.avgClvVsYearAgo || mixIn === null || mixOut === null) return null
  return {
    ce1: c.customerEquity,
    change: y.abs,
    changePrev: view.yearAgo?.equityVsYearAgo?.abs ?? null,
    n: c.activeVsYearAgo.pct,
    v: c.avgClvVsYearAgo.pct,
    vAbs: c.avgClvVsYearAgo.abs,
    mix: s.customerMix,
    mixIn,
    mixOut,
    val: s.existingCustomerValue,
    parts: w.parts,
  }
}

// ---------------------------------------------------------------------------
// Woorden voor de redenen van de CLV-verandering
// ---------------------------------------------------------------------------
/** Marker van de uitleg van wie kwam en ging (voor de test op dubbele uitleg). */
export const STAYERS = 'than the customers who stayed'

/**
 * Wie kwam en ging, als bijzin: het deel dat de doorslag gaf (nieuwkomers of vertrekkers t.o.v. de
 * blijvers), met het bedrag per klant. Met withSecond ook het kleinere deel, zonder bedrag, met wat
 * het deed ("that leavers were worth less too softened this a little"), vanaf OFFSET_SHARE.
 * Nieuwkomers > 0: meer waard dan de blijvers. Vertrekkers > 0: minder waard (dat verhoogt de CLV).
 */
export function joinersClause(mixIn: number, mixOut: number, withSecond = true): string {
  const inPart = { who: 'newcomers', v: mixIn, word: mixIn >= 0 ? 'more' : 'less' }
  const outPart = { who: 'leavers', v: mixOut, word: mixOut >= 0 ? 'less' : 'more' }
  const [first, second] = Math.abs(mixIn) >= Math.abs(mixOut) ? [inPart, outPart] : [outPart, inPart]
  let text =
    first.who === 'newcomers'
      ? `newcomers were worth ${first.word} ${STAYERS} (${gb.signedClv(first.v)})`
      : `leavers were worth ${first.word} ${STAYERS}, which ${first.v >= 0 ? 'raised' : 'lowered'} average CLV by ${gb.clv(Math.abs(first.v))}`
  const share = first.v === 0 ? 0 : Math.abs(second.v) / Math.abs(first.v)
  if (withSecond && second.v !== 0 && share >= OFFSET_SHARE) {
    const list = first.v * second.v > 0 ? SECOND_WORDS.strengthened : SECOND_WORDS.softened
    const effect = list.find((t) => share < t.below)!.words
    const too = second.word === first.word ? ' too' : ''
    text += `; that ${second.who} were worth ${second.word}${too} ${effect}`
  }
  return text
}
const existingClause = (up: boolean, value: number) =>
  `existing customers became ${up ? 'more' : 'less'} valuable (${gb.signedClv(value)})`

export function executiveSummary(i: SummaryInput): { sentences: string[]; branches: Branches } {
  // -------------------------------------------------------------------------
  // 1. Resultaat
  // -------------------------------------------------------------------------
  const flat = Math.abs(i.change) < FLAT_SHARE * i.ce1
  const up = i.change >= 0
  const how = flat ? 'about the same as a year ago' : `${amount(i.change)} ${up ? 'more' : 'less'} than a year ago`
  let compare = ''
  let s1 = flat ? 'gelijk aan vorig jaar' : up ? 'meer' : 'minder'
  if (i.changePrev !== null) {
    const prevUp = i.changePrev >= 0
    const diff = i.change - i.changePrev
    s1 += diff > IN_LINE_SHARE * i.ce1 ? ', beter' : diff < -IN_LINE_SHARE * i.ce1 ? ', zwakker' : ', gelijk'
    if (flat || up !== prevUp) {
      // Andere richting dan het jaar ervoor (of nu vlak): noem gewoon wat er het jaar ervoor gebeurde.
      compare = `, after a ${prevUp ? 'rise' : 'fall'} of ${amount(i.changePrev)} the year before`
    } else {
      const word = up ? 'increase' : 'fall'
      if (Math.abs(diff) <= IN_LINE_SHARE * i.ce1) {
        compare = `, about the same ${word} as the year before (${amount(i.changePrev)})`
      } else {
        const bigger = Math.abs(i.change) > Math.abs(i.changePrev)
        compare = `, a ${bigger ? 'bigger' : 'smaller'} ${word} than the year before (${amount(i.changePrev)})`
      }
    }
  } else {
    s1 += ', geen vorig jaar'
  }
  const S1 = `Your customer base is worth ${amount(i.ce1)}, ${how}${compare}.`

  // -------------------------------------------------------------------------
  // 2. Verklaring: klanten en CLV, en (bij een CLV-verandering vanaf 1%) waarom
  // -------------------------------------------------------------------------
  const dn = Math.abs(i.n) < STEADY ? 0 : i.n > 0 ? 1 : -1
  const small = Math.abs(i.v) < SMALL_CLV
  const dv = i.v > 0 ? 1 : -1
  const customers = dn === 0 ? 'Customers held steady' : `Customers ${dn > 0 ? 'grew' : 'fell'} ${pct(i.n)}`
  const perCustomer = `(${gb.signedClv(i.vAbs)} per customer)`
  const valMain = Math.abs(i.val) >= Math.abs(i.mix)
  const main = valMain ? i.val : i.mix
  const other = valMain ? i.mix : i.val
  const showOther = !small && other * main < 0 && Math.abs(other) >= OFFSET_SHARE * Math.abs(main)
  // Wat S2 uitlegt (teken per klant), zodat S3 er alleen kort naar verwijst.
  const said = {
    mix: !small && (!valMain || showOther) ? Math.sign(i.mix) : 0,
    val: !small && (valMain || showOther) ? Math.sign(i.val) : 0,
  }
  let S2: string
  if (small) {
    S2 = `${customers} and average CLV barely changed ${perCustomer}.`
  } else {
    const join = dn !== 0 && dn !== dv ? 'but' : 'and'
    const clv = `average CLV ${dv > 0 ? 'rose' : 'fell'} ${pct(i.v)} ${perCustomer}`
    const reason = valMain ? existingClause(i.val >= 0, i.val) : joinersClause(i.mixIn, i.mixOut)
    // Wie kwam en ging als tegenwerkende reden: alleen het grootste deel (nieuwkomers of vertrekkers).
    const offset = showOther ? `, although ${valMain ? joinersClause(i.mixIn, i.mixOut, false) : existingClause(i.val >= 0, i.val)}` : ''
    S2 = `${customers} ${join} ${clv}, mainly because ${reason}${offset}.`
  }
  const s2 = `${dn > 0 ? 'klanten +' : dn < 0 ? 'klanten −' : 'klanten ='} ${small ? 'CLV ≈' : dv > 0 ? 'CLV +' : 'CLV −'}`
  const r = small
    ? 'geen reden (CLV < 1%)'
    : (valMain ? (i.val >= 0 ? 'bestaand +' : 'bestaand −') : i.mix >= 0 ? 'kwam/ging +' : 'kwam/ging −') +
      (showOther ? ', met tegenwerking' : '')

  // -------------------------------------------------------------------------
  // 3. Grootste eenduidige verlies over het jaar (in euro)
  // -------------------------------------------------------------------------
  // Eenduidig: vertrekkers altijd; wie kwam en ging en bestaande klanten alleen als het jaarbedrag
  // en het effect per klant over het jaar dezelfde richting hebben.
  const candidates: { k: keyof SummaryParts; value: number }[] = [
    { k: 'churn', value: i.parts.churn },
    { k: 'customerMix', value: i.mix < 0 ? i.parts.customerMix : 0 },
    { k: 'existingCustomerValue', value: i.val < 0 ? i.parts.existingCustomerValue : 0 },
  ]
  const worst = candidates.reduce((a, b) => (b.value < a.value ? b : a))
  const sentences = [S1, S2]
  let s3 = 'geen eenduidig negatief onderdeel'
  if (worst.value < 0) {
    const loss = amount(worst.value)
    // CLV nauwelijks veranderd: het andere onderdeel van de CLV compenseerde het verlies (deels).
    // (Alleen gebruikt bij een verlies van bestaande klanten: nieuwkomers en vertrekkers compenseerden.)
    const offsetBy = (otherPart: number) =>
      small && otherPart > 0
        ? `, ${otherPart >= Math.abs(worst.value) ? 'offset' : 'partly offset'} because newcomers and leavers together raised average CLV (${amount(otherPart)})`
        : ''
    let S3: string
    if (worst.k === 'churn') {
      const joined = i.parts.newCustomers + i.parts.reacquiredCustomers
      const ratio = joined > 0 ? Math.abs(i.parts.churn) / joined : Infinity
      const C = CHURN_WORDS.find((t) => ratio >= t.min)!.words
      S3 = `The biggest loss was customers who left: they took ${loss} of value with them, ${C} the ${amount(joined)} that new and returning customers brought in.`
      s3 = `vertrek: ${C}`
    } else if (worst.k === 'existingCustomerValue') {
      if (said.val < 0) {
        S3 = `That fall in the value of existing customers was also the biggest loss (${loss}).`
        s3 = 'bestaand (al uitgelegd)'
      } else {
        S3 = `The biggest loss (${loss}) came from existing customers becoming less valuable${offsetBy(i.parts.customerMix)}.`
        s3 = 'bestaand' + (small && i.parts.customerMix > 0 ? ', gecompenseerd' : '')
      }
    } else {
      if (said.mix < 0) {
        S3 = `That shift in who joined and who left was also the biggest loss (${loss}).`
        s3 = 'kwam/ging (al uitgelegd)'
      } else {
        const ev = i.parts.existingCustomerValue
        const comp =
          small && ev > 0
            ? `; existing customers becoming more valuable ${ev >= Math.abs(worst.value) ? 'offset' : 'partly offset'} this (${amount(ev)})`
            : ''
        S3 = `The biggest loss (${loss}) came from the shift in who joined and who left: ${joinersClause(i.mixIn, i.mixOut)}${comp}.`
        s3 = 'kwam/ging' + (small && i.parts.existingCustomerValue > 0 ? ', gecompenseerd' : '')
      }
    }
    sentences.push(S3)
  }
  return { sentences, branches: { s1, s2, r, s3 } }
}
