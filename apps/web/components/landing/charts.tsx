/* Static figures of the landing page: clock vs money bars, p99 gaps, one close as a sky path,
   the Session Oracle band and the guardian seal. Server-rendered SVG. */
import type { BandExample } from "@/lib/band";
import { r2 } from "@/lib/planisphere/geometry";
import type { ShareKind } from "@/lib/planisphere/sessions";

const INK = "#f3ecd9";
const NAVY = "#0b1733";
const MUTED = "#8fa3c9";
const f1 = (x: number) => x.toFixed(1);
const pm = "\u00b1";

/* WCAG relative luminance and contrast, to pick the label ink on each bar segment */
function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** navy on the light segments, cream on the dark ones: whichever reads better */
export const labelInk = (fill: string) => (contrast(NAVY, fill) >= contrast(INK, fill) ? NAVY : INK);

/* ---------- clock vs money ---------- */

/* the one-hue session ramp, light = more open */
export const SESSION_GROUPS: readonly { key: ShareKind; name: string; color: string }[] = [
  { key: "regular", name: "Regular session", color: "#e6ecf7" },
  { key: "prePost", name: "Pre and after hours", color: "#b5c4e2" },
  { key: "overnight", name: "Overnight", color: "#8399c8" },
  { key: "holiday", name: "Holiday", color: "#5f78b2" },
  { key: "weekend", name: "Weekend", color: "#4a639f" },
];

export function SessionLegend({ className }: { className?: string }) {
  return (
    <div className={className}>
      {SESSION_GROUPS.map((k) => (
        <span key={k.key}>
          <i style={{ background: k.color }} />
          {k.name}
        </span>
      ))}
    </div>
  );
}

const share1 = (x: number) => Math.round(x * 1000) / 10;
const shareText = (x: number) => {
  const v = share1(x);
  return `${v % 1 ? v.toFixed(1) : v}%`;
};

/** Clock (from the calendar over the sample window) against dollars (from the liquidation file). */
export function SessionShares({ clock, dollars }: { clock: Record<ShareKind, number>; dollars: Record<ShareKind, number> }) {
  const x0 = 120;
  const w = 500;
  const h = 40;
  const describe = (s: Record<ShareKind, number>) => SESSION_GROUPS.map((k) => `${k.name.toLowerCase()} ${shareText(s[k.key])}`).join(", ");
  return (
    <svg viewBox="0 0 640 170" role="img" aria-label={`Two stacked bars. Clock: ${describe(clock)}. Dollars: ${describe(dollars)}.`}>
      {[clock, dollars].map((col, row) => {
        const y = 20 + row * 78;
        let x = x0;
        return (
          <g key={row}>
            <text className="f-display" x={0} y={y + h / 2 + 6} fontSize={22} fill={INK}>
              {row ? "Dollars" : "Clock"}
            </text>
            {SESSION_GROUPS.map((k) => {
              const v = col[k.key];
              const ww = w * v;
              const at = x;
              x += ww;
              if (share1(v) <= 0) return null;
              return (
                <g key={k.key}>
                  <rect x={r2(at + 1)} y={y} width={r2(Math.max(1, ww - 2))} height={h} fill={k.color} rx={2} />
                  {ww > 46 && (
                    <text className="f-ui" x={r2(at + ww / 2)} y={y + h / 2 + 5} textAnchor="middle" fontSize={14} fontWeight={500} fill={labelInk(k.color)}>
                      {shareText(v)}
                    </text>
                  )}
                </g>
              );
            })}
            <text className="f-ui" x={x0 + w} y={y + h + 22} textAnchor="end" fontSize={13} fill={MUTED}>
              {row ? `Weekend: ${Math.round(dollars.weekend * 100)}%` : `Weekend: ${Math.round(clock.weekend * 100)}% of the clock`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- p99 down-gaps ---------- */

/* pooled p99 down-gaps from the gap study (data/README.md, "Figures from the gap study") */
export const P99_GAPS = [
  ["Overnight", 4.4],
  ["Weekend", 5.5],
  ["Holiday", 4.3],
  ["Earnings", 17.9],
] as const;

export function GapBars() {
  const x0 = 96;
  const w = 300;
  return (
    <svg viewBox="0 0 460 190" role="img" aria-label="p99 down-gap by window: overnight 4.4%, weekend 5.5%, holiday 4.3%, earnings 17.9%.">
      {P99_GAPS.map(([n, v], i) => {
        const y = 12 + i * 44;
        const ww = (w * v) / 17.9;
        return (
          <g key={n}>
            <text className="f-ui" x={0} y={y + 16} fontSize={15} fill={INK}>
              {n}
            </text>
            <rect x={x0} y={y + 2} width={r2(ww)} height={20} fill="#e6ecf7" rx={2} />
            <text className="f-display" x={r2(x0 + ww + 8)} y={y + 18} fontSize={22} fontWeight={600} fill={INK}>
              {v}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- one close as a sky path ---------- */

/* deterministic decoration: a fixed seed, so the stars never move between renders */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function DayArc({ mobile, className }: { mobile: boolean; className?: string }) {
  const W = mobile ? 560 : 1100;
  const k = mobile ? 1.55 : 1;
  const hz = mobile ? 130 : 110;
  const ink = "#0b1733";
  const mut = "#4a5878";
  const t0 = 12.5;
  const t1 = 36.5;
  const x = (t: number) => 40 + ((t - t0) / (t1 - t0)) * (W - 80);
  const yDay = (t: number) => {
    const s = t < 24 ? (16 - t) / 6.5 : (t - 33.5) / 6.5;
    return hz - Math.sin(Math.max(0, Math.min(1, s)) * (Math.PI / 2)) * 80;
  };
  const trace = (a: number, b: number, y: (t: number) => number) => {
    let d = "";
    for (let t = a; t <= b; t += 0.1) d += (d ? "L" : "M") + f1(x(t)) + " " + f1(y(t));
    return d;
  };
  let night = `M${x(16)} ${hz}`;
  for (let t = 16; t <= 33.5; t += 0.1) night += `L${f1(x(t))} ${f1(hz + Math.sin(((t - 16) / 17.5) * Math.PI) * 100)}`;
  const rnd = lcg(3);
  const stars = Array.from({ length: 34 }, () => {
    const t = 16.5 + rnd() * 16.5;
    const s = (t - 16) / 17.5;
    const cy = hz + 6 + rnd() * Math.sin(s * Math.PI) * 84;
    return { cx: r2(x(t)), cy: r2(cy), r: r2(rnd() * 1.2 + 0.4) };
  });
  const stations = [
    { t: 15, y: yDay(15), n: "1", label: "3:00 PM" },
    { t: 24.75, y: hz + 100, n: "2", label: "closed" },
    { t: 35, y: yDay(35), n: "3", label: "11:00 AM" },
  ];
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${mobile ? 300 : 250}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="One close drawn as a sky path. Afternoon on the left, the night as a dip below the horizon in the middle, the next morning on the right. Step 1 at 3:00 PM, step 2 through the night, step 3 at 11:00 AM."
    >
      <line x1={20} x2={W - 20} y1={hz} y2={hz} stroke={ink} strokeWidth={1} />
      <path d={trace(t0, 16, yDay)} fill="none" stroke={ink} strokeWidth={2.2} />
      <path d={trace(33.5, t1, yDay)} fill="none" stroke={ink} strokeWidth={2.2} />
      <path d={night + "Z"} fill="#12244a" opacity={0.92} />
      {stars.map((s, i) => (
        <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="#fff6d8" opacity={0.7} />
      ))}
      <rect x={r2(x(33.5))} y={hz - 92} width={r2(x(35) - x(33.5))} height={92} fill="#b8401f" opacity={0.09} />
      <text className="f-ui" x={r2((x(33.5) + x(35)) / 2)} y={hz - 98} textAnchor="middle" fontSize={12 * k} fill="#b8401f">
        first 90 min
      </text>
      {(
        [
          [16, "4:00 PM close"],
          [33.5, "9:30 AM open"],
        ] as const
      ).map(([t, s]) => (
        <g key={t}>
          <line x1={r2(x(t))} x2={r2(x(t))} y1={hz - 6} y2={hz + 6} stroke={ink} strokeWidth={2} />
          {!mobile && (
            <text className="f-ui" x={r2(x(t) + (t < 20 ? 8 : -8))} y={hz - 12} textAnchor={t < 20 ? "start" : "end"} fontSize={13 * k} fill={mut}>
              {s}
            </text>
          )}
        </g>
      ))}
      {stations.map(({ t, y, n, label }) => {
        const cx = r2(x(t));
        return (
          <g key={n}>
            <circle cx={cx} cy={r2(y)} r={15 * Math.min(k, 1.3)} fill="#faf6ea" stroke={ink} strokeWidth={2} />
            <text className="f-ui" x={cx} y={r2(y + 5 * k)} textAnchor="middle" fontSize={14 * k} fontWeight={500} fill={ink}>
              {n}
            </text>
            <text className="f-display" x={cx} y={r2(n === "2" ? y + 34 * k : y - 24 * k)} textAnchor="middle" fontStyle="italic" fontSize={18 * k} fill={ink}>
              {label}
            </text>
          </g>
        );
      })}
      <text className="f-display" x={r2(x(24.75))} y={hz + 58} textAnchor="middle" fontStyle="italic" fontSize={(mobile ? 15 : 20) * k} fill="#dfe5f1">
        {mobile ? "Refuse what adds risk" : "Refuse anything that adds risk"}
      </text>
    </svg>
  );
}

/* ---------- Session Oracle band ---------- */

const pctBps = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/** One row per closure kind: the band the contract enforces, from the close to the next open. */
export function OracleBand({ examples, symbol, mobile, className }: { examples: readonly BandExample[]; symbol: string; mobile: boolean; className?: string }) {
  const W = mobile ? 360 : 700;
  const x0 = mobile ? 8 : 170;
  const x1 = mobile ? 340 : 560;
  const H_MAX = 90;
  const BPS_MAX = 2400;
  const rowH = mobile ? 122 : 98;
  const top = 30;
  const plotH = mobile ? 60 : 76;
  const xh = (h: number) => x0 + (h / H_MAX) * (x1 - x0);
  const height = top + examples.length * rowH + (mobile ? 4 : 6);
  const summary = examples
    .map(
      (e) =>
        `${e.label.toLowerCase()} from plus or minus ${pctBps(e.baseBps)} at the close to ${pctBps(e.openBps)} at the open ${e.hours} hours later${e.capAtHours !== null ? `, capped at three times after ${e.capAtHours} hours` : ""}`,
    )
    .join("; ");
  return (
    <svg className={className} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`The price band the oracle enforces for ${symbol} while New York is closed: ${summary}.`}>
      {[0, 24, 48, 72].map((h) => (
        <g key={h}>
          {/* day lines run through the plots only, never through the row labels */}
          {mobile ? (
            examples.map((_, i) => {
              const yb = top + (i + 1) * rowH - 14;
              return <line key={i} x1={r2(xh(h))} x2={r2(xh(h))} y1={yb - plotH - 4} y2={yb} stroke="#2a4677" strokeWidth={1} />;
            })
          ) : (
            <line x1={r2(xh(h))} x2={r2(xh(h))} y1={top - 8} y2={height - 4} stroke="#2a4677" strokeWidth={1} />
          )}
          <text className="f-ui" x={r2(xh(h))} y={top - 14} textAnchor={h ? "middle" : "start"} fontSize={12} fill={MUTED}>
            {h ? `+${h} h` : "close"}
          </text>
        </g>
      ))}
      {examples.map((e, i) => {
        const y0 = top + i * rowH;
        const yb = y0 + rowH - (mobile ? 14 : 10);
        const y = (bps: number) => yb - (bps / BPS_MAX) * plotH;
        const line = e.curve.map(([h, b], k) => `${k ? "L" : "M"}${f1(xh(h))} ${f1(y(b))}`).join("");
        const xe = xh(e.hours);
        const ye = y(e.openBps);
        const cap = e.capAtHours;
        return (
          <g key={e.window}>
            <line x1={x0} x2={x1} y1={yb} y2={yb} stroke="#2a4677" strokeWidth={1} />
            <path d={`${line}L${f1(xe)} ${yb}L${f1(xh(0))} ${yb}Z`} fill="#3ef0b5" opacity={0.13} />
            <path d={line} fill="none" stroke="#3ef0b5" strokeWidth={1.6} />
            <circle cx={r2(xh(0))} cy={r2(y(e.baseBps))} r={3.2} fill={INK} />
            <circle cx={r2(xe)} cy={r2(ye)} r={3.2} fill="#12244a" stroke="#3ef0b5" strokeWidth={1.6} />
            {cap !== null && (
              <text className="f-ui" x={r2(xh(cap) + 4)} y={r2(mobile ? y(e.openBps) + 15 : y(e.openBps) - 7)} fontSize={11.5} fill={mobile ? "#bac7df" : MUTED}>
                capped at 3x
              </text>
            )}
            {mobile ? (
              <>
                <text className="f-display" x={x0} y={y0 + 16} fontSize={18} fill={INK}>
                  {e.label}
                </text>
                <text className="f-ui" x={x0} y={y0 + 34} fontSize={12} fill={MUTED}>
                  {`${pm}${pctBps(e.baseBps)} at the close, ${pm}${pctBps(e.openBps)} at the open, ${e.hours} h later`}
                </text>
              </>
            ) : (
              <>
                <text className="f-display" x={0} y={y0 + 34} fontSize={20} fill={INK}>
                  {e.label}
                </text>
                <text className="f-ui" x={0} y={y0 + 56} fontSize={13} fill={MUTED}>
                  {`p99 gap ${pm}${pctBps(e.baseBps)}`}
                </text>
                <text className="f-ui" x={0} y={y0 + 74} fontSize={13} fill={MUTED}>
                  {`closed ${e.hours} h`}
                </text>
                <text className="f-ui" x={r2(xe + 9)} y={r2(ye + 4)} fontSize={13} fill={INK}>
                  {`${pm}${pctBps(e.openBps)} at the open`}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- guardian seal ---------- */

export function GuardianSeal() {
  return (
    <svg viewBox="0 0 84 84" aria-hidden="true">
      <circle cx={42} cy={42} r={40} fill="none" stroke="#d8ccab" strokeWidth={1} />
      <circle cx={42} cy={42} r={33} fill="#12244a" stroke="#3d5a94" strokeWidth={1} />
      {Array.from({ length: 42 }, (_, i) => {
        const a = (i / 42) * Math.PI * 2 - Math.PI / 2;
        return (
          <line
            key={i}
            x1={r2(42 + Math.cos(a) * 35)}
            y1={r2(42 + Math.sin(a) * 35)}
            x2={r2(42 + Math.cos(a) * 39)}
            y2={r2(42 + Math.sin(a) * 39)}
            stroke={i === 29 ? "#ff9f80" : "#3ef0b5"}
            strokeWidth={1.6}
          />
        );
      })}
      <text className="f-display" x={42} y={49} textAnchor="middle" fontSize={22} fontWeight={600} fill={INK}>
        318
      </text>
    </svg>
  );
}
