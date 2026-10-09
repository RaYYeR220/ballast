/* The load gauge: loan-to-value now, after the coming gap and after other gaps, against the owner's shield LTV
   (the floor for a collateral sale) and the liquidation LTV. Drawn twice (desktop and phone proportions) and
   switched by CSS. Labels that would collide are moved; a figure is never dropped to make room. */
import s from "./app.module.css";

export interface GaugeMark {
  /** percent */
  value: number;
  label: string;
  short: string;
}

export interface GaugeProps {
  now: number;
  after: GaugeMark | null;
  scenarios: GaugeMark[];
  shield: number;
  lltv: number;
  label: string;
}

const pct = (v: number) => `${v.toFixed(1)}%`;

export function gaugeScale(now: number, lltv: number): [number, number] {
  const v0 = Math.max(0, Math.min(30, Math.floor((now - 10) / 10) * 10));
  const v1 = Math.min(100, Math.ceil((lltv + 5) / 10) * 10);
  return [v0, Math.max(v1, v0 + 20)];
}

/** label widths are estimated: Jost runs about half an em per character */
const textWidth = (text: string, size: number) => text.length * size * 0.52;

export interface BelowLabel extends GaugeMark {
  text: string;
  /** reads to the left of its tick */
  end: boolean;
  row: number;
}

/**
 * Labels under the bar. Two that fit share a row: the lower reads to the left, the higher to the right. When the
 * higher one would run past the right edge, or there are more than two, each reads to the left on its own row,
 * lowest first, so no leader line crosses a label.
 */
export function layoutBelow(marks: GaugeMark[], x: (v: number) => number, W: number, size: number, mob: boolean): BelowLabel[] {
  const sorted = [...marks].sort((a, b) => a.value - b.value);
  const texts = sorted.map((m) => (mob ? `${m.short} ${pct(m.value)}` : `${m.label} ${pct(m.value)}`));
  const last = sorted.length - 1;
  if (last < 0) return [];
  const runsOver = x(sorted[last]!.value) - 2 + textWidth(texts[last]!, size) > W;
  const rows = sorted.length > 2 || (sorted.length === 2 && runsOver);
  return sorted.map((m, i) => ({ ...m, text: texts[i]!, end: rows || i < last || sorted.length === 1, row: rows ? i : 0 }));
}

function Drawing({ mob, p }: { mob: boolean; p: GaugeProps }) {
  const W = mob ? 420 : 760;
  const fm = mob ? 1.3 : 1;
  const l = 10;
  const r = 24;
  const [V0, V1] = gaugeScale(p.now, p.lltv);
  const clamp = (v: number) => Math.max(V0, Math.min(V1, v));
  const x = (v: number) => Math.round((l + ((clamp(v) - V0) / (V1 - V0)) * (W - l - r)) * 10) / 10;
  const y0 = mob ? 80 : 70;
  const h = 22;
  const ticks: number[] = [];
  for (let v = V0; v <= V1; v += 5) ticks.push(v);
  const shield = clamp(p.shield);
  const liq = clamp(p.lltv);

  // the two limit labels share a row unless they would touch; then the liquidation label goes one row up
  const shieldText = mob ? `Shield LTV ${p.shield.toFixed(0)}%` : `Shield LTV, ${p.shield.toFixed(0)}%`;
  const liqText = mob ? "Liquidation" : `Liquidation, ${p.lltv.toFixed(0)}%`;
  const limitY = y0 - 34 * fm;
  const shieldEnd = x(shield) + 6 + textWidth(shieldText, 12.5 * fm);
  const liqStart = mob ? x(liq) - 6 - textWidth(liqText, 12.5 * fm) : x(liq) + 6;
  const liqUp = shieldEnd + 6 > liqStart ? 17 * fm : 0;

  // "now" reads to the left of its mark, "after" to the right when it ends before the liquidation line
  const nowText = `now ${pct(p.now)}`;
  const afterBeside = p.after ? (mob ? pct(p.after.value) : `${p.after.label} ${pct(p.after.value)}`) : "";
  const afterEnd = p.after ? x(p.after.value) + 6 + textWidth(afterBeside, 13 * fm) : 0;
  const crowded = !!p.after && afterEnd > (p.after.value < p.lltv ? x(liq) - 4 : W);
  // crowded: on a wide gauge the two figures stack to the left of "now"; on a phone "after" joins the list below
  const stackAbove = crowded && !mob;
  const below = layoutBelow(crowded && mob && p.after ? [...p.scenarios, p.after] : p.scenarios, x, W, 12 * fm, mob);
  const extraRows = below.reduce((m, b) => Math.max(m, b.row), 0);
  const top = liqUp > 0 ? Math.min(0, limitY - liqUp - 13 * fm) : 0;
  const height = (mob ? 190 : 160) + extraRows * 15 * fm;

  return (
    <svg className={`${s.gauge} ${mob ? s.gaugeMob : s.gaugeDesk}`} viewBox={`0 ${top} ${W} ${height - top}`} role="img" aria-label={p.label}>
      <rect x={x(V0)} y={y0} width={Math.max(0, x(shield) - x(V0) - 1)} height={h} fill="#3d5a94" opacity={0.55} rx={2} />
      <rect x={x(shield) + 1} y={y0} width={Math.max(0, x(liq) - x(shield) - 2)} height={h} fill="#2a4677" opacity={0.7} rx={2} />
      <rect x={x(liq) + 1} y={y0} width={Math.max(0, x(V1) - x(liq) - 1)} height={h} fill="#ff9f80" opacity={0.35} rx={2} />
      {ticks.map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={y0 + h + 4} y2={y0 + h + 9} stroke="#6178ac" />
          {v % 10 === 0 ? (
            <text className="f-ui" x={x(v)} y={y0 + h + 25 * fm} textAnchor="middle" fontSize={12 * fm} fill="#8fa3c9">
              {v}%
            </text>
          ) : null}
        </g>
      ))}
      <line x1={x(shield)} x2={x(shield)} y1={y0 - 40 * fm} y2={y0 + h + 2} stroke="#3ef0b5" strokeWidth={2} strokeDasharray="3 3" />
      <text className="f-ui" x={x(shield) + 6} y={limitY} fontSize={12.5 * fm} fill="#3ef0b5">
        {shieldText}
      </text>
      <line x1={x(liq)} x2={x(liq)} y1={y0 - 40 * fm - liqUp} y2={y0 + h + 2} stroke="#ff9f80" strokeWidth={2} />
      <text className="f-ui" x={x(liq) + (mob ? -6 : 6)} y={limitY - liqUp} textAnchor={mob ? "end" : "start"} fontSize={12.5 * fm} fill="#ff9f80">
        {liqText}
      </text>
      <rect x={x(p.now) - 2} y={y0 - 6} width={4} height={h + 12} fill="#f3ecd9" />
      {p.after ? <rect x={x(p.after.value) - 2} y={y0 - 6} width={4} height={h + 12} fill="none" stroke="#f3ecd9" strokeWidth={1.2} /> : null}
      <text className="f-ui" x={x(p.now) - 8} y={y0 - 12 - (stackAbove ? 16 : 0)} textAnchor="end" fontSize={13 * fm} fontWeight={500} fill="#f3ecd9">
        {nowText}
      </text>
      {p.after && stackAbove ? (
        <text className="f-ui" x={x(p.now) - 8} y={y0 - 12} textAnchor="end" fontSize={13} fill="#d8ccab">
          {afterBeside}
        </text>
      ) : null}
      {p.after && !crowded ? (
        <text className="f-ui" x={x(p.after.value) + 6} y={y0 - 12} textAnchor="start" fontSize={13 * fm} fill="#d8ccab">
          {afterBeside}
        </text>
      ) : null}
      {below.map((m) => {
        const own = m.label === p.after?.label;
        return (
          <g key={m.label}>
            {own ? null : <line x1={x(m.value)} x2={x(m.value)} y1={y0 + 2} y2={y0 + h - 2} stroke="#bac7df" strokeWidth={1.5} opacity={0.85} />}
            <line x1={x(m.value)} x2={x(m.value)} y1={y0 + h + 32 * fm} y2={y0 + h + (38 + m.row * 15) * fm} stroke="#8fa3c9" />
            <text
              className="f-ui"
              x={x(m.value) + (m.end ? 2 : -2)}
              y={y0 + h + (54 + m.row * 15) * fm}
              textAnchor={m.end ? "end" : "start"}
              fontSize={12 * fm}
              fill={own ? "#d8ccab" : "#8fa3c9"}
            >
              {m.text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Gauge(p: GaugeProps) {
  return (
    <>
      <Drawing mob={false} p={p} />
      <Drawing mob p={p} />
    </>
  );
}
