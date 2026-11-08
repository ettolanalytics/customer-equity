import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useElementWidth } from '../hooks/useElementWidth'
import type { TrendPointView } from '../lib/dashboardModel'

interface TrendChartProps {
  points: TrendPointView[]
  referenceValue: number
  referenceLabel: string
  ariaLabel: string
  formatValue: (value: number) => string
  formatTick: (value: number) => string
}

const HEIGHT = 230
const PLOT_TOP = 12
const PLOT_BOTTOM = 200
const PLOT_LEFT = 52
const PLOT_RIGHT_GAP = 12

/** Ronde as-waarden rond de reeks, met hooguit `maxTicks` streepjes. */
function niceTicks(values: number[], maxTicks = 6): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || Math.abs(max) || 1
  const magnitude = 10 ** Math.floor(Math.log10(range))
  const step =
    [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10]
      .map((f) => f * magnitude)
      .find((s) => Math.ceil(max / s) - Math.floor(min / s) + 1 <= maxTicks) ?? magnitude * 10
  const start = Math.floor(min / step)
  const end = Math.ceil(max / step)
  return Array.from({ length: end - start + 1 }, (_, i) => (start + i) * step)
}

export function TrendChart({
  points,
  referenceValue,
  referenceLabel,
  ariaLabel,
  formatValue,
  formatTick,
}: TrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(containerRef, 640)
  const [active, setActive] = useState<number | null>(null)

  const lastIndex = points.length - 1
  const plotRight = width - PLOT_RIGHT_GAP
  const step = (plotRight - PLOT_LEFT) / Math.max(lastIndex, 1)
  const ticks = niceTicks([...points.map((p) => p.value), referenceValue])
  const vMin = ticks[0]
  const vMax = ticks[ticks.length - 1]
  const x = (i: number) => PLOT_LEFT + i * step
  const y = (v: number) => PLOT_BOTTOM - ((v - vMin) / (vMax - vMin)) * (PLOT_BOTTOM - PLOT_TOP)

  const linePath = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(' ')
  const areaPath = `${linePath} L${x(lastIndex).toFixed(1)} ${PLOT_BOTTOM} L${PLOT_LEFT} ${PLOT_BOTTOM} Z`
  const shown = active ?? lastIndex
  const labelEvery = step < 36 ? 2 : 1

  function indexAt(event: PointerEvent<SVGSVGElement>): number {
    const left = event.currentTarget.getBoundingClientRect().left
    const i = Math.round((event.clientX - left - PLOT_LEFT) / step)
    return Math.min(Math.max(i, 0), lastIndex)
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(shown - 1, 0),
      ArrowRight: Math.min(shown + 1, lastIndex),
      Home: 0,
      End: lastIndex,
    }
    if (event.key in moves) {
      event.preventDefault()
      setActive(moves[event.key])
    }
  }

  return (
    <div className="chart" ref={containerRef}>
      <div className="chart__header">
        <div className="chart__legend">
          <span className="chart__key">
            <span className="swatch swatch--line" />
            Customer equity
          </span>
          <span className="chart__key">
            <span className="swatch swatch--dashed" />
            Niveau {referenceLabel}
          </span>
        </div>
        <span className="chart__readout" aria-live="polite">
          {points[shown].label} · {formatValue(points[shown].value)}
        </span>
      </div>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={`${ariaLabel}. Gebruik de pijltjestoetsen om per maand de waarde te lezen.`}
        tabIndex={0}
        onPointerMove={(e) => setActive(indexAt(e))}
        onPointerDown={(e) => setActive(indexAt(e))}
        onPointerLeave={() => setActive(null)}
        onKeyDown={handleKeyDown}
        onBlur={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart__grid" x1={PLOT_LEFT} x2={plotRight} y1={y(t)} y2={y(t)} />
            <text className="chart__tick" x={PLOT_LEFT - 8} y={y(t) + 4} textAnchor="end">
              {formatTick(t)}
            </text>
          </g>
        ))}
        <line className="chart__axis" x1={PLOT_LEFT} x2={plotRight} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
        <path className="chart__area" d={areaPath} />
        <line
          className="chart__reference"
          x1={PLOT_LEFT}
          x2={plotRight}
          y1={y(referenceValue)}
          y2={y(referenceValue)}
        />
        <path className="chart__line" d={linePath} />
        {active !== null && (
          <line className="chart__axis" x1={x(shown)} x2={x(shown)} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
        )}
        <circle className="chart__dot" cx={x(shown)} cy={y(points[shown].value)} r={5} />
        {points.map((p, i) =>
          (lastIndex - i) % labelEvery === 0 ? (
            <text key={p.label} className="chart__tick" x={x(i)} y={220} textAnchor="middle">
              {p.shortLabel}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  )
}
