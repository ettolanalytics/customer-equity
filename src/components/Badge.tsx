import type { Measurement } from '../data/types'

const LABELS: Record<Measurement, string> = {
  measured: 'Gemeten',
  calculated: 'Berekend',
  proxy: 'Proxy',
}

export function Badge({ kind, flush = false }: { kind: Measurement; flush?: boolean }) {
  return <span className={`badge badge--${kind}${flush ? ' badge--flush' : ''}`}>{LABELS[kind]}</span>
}

export function Change({ text, isPositive }: { text: string; isPositive: boolean }) {
  return <span className={`change ${isPositive ? 'up' : 'down'}`}>{text}</span>
}
