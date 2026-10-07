/* Static figures of the landing page, ported from v09-landing.html: clock vs money bars, p99 gaps,
   one close as a sky path, the Session Oracle band and the guardian seal. Server-rendered SVG. */
import { r2 } from "@/lib/planisphere/geometry";

const INK = "#f3ecd9";
const MUTED = "#8fa3c9";
const f1 = (x: number) => x.toFixed(1);

/* ---------- clock vs money ---------- */

/* session shares from the S2 measurement: share of the clock, share of liquidated dollars (120 bStock-collateral rows) */
export const SESSION_SHARES = [
  { name: "Regular session", color: "#e6ecf7", clock: 18.4, dollars: 85.5 },
  { name: "Pre and after hours", color: "#b5c4e2", clock: 26.8, dollars: 7.3 },
  { name: "Overnight", color: "#8399c8", clock: 22.7, dollars: 7.1 },
  { name: "Holiday", color: "#5f78b2", clock: 3.1, dollars: 0.1 },
  { name: "Weekend", color: "#4a639f", clock: 29.0, dollars: 0 },
] as const;

export function SessionLegend({ className }: { className?: string }) {
  return (
    <div className={className}>
      {SESSION_SHARES.map((k) => (
        <span key={k.name}>
          <i style={{ background: k.color }} />
          {k.name}
        </span>
      ))}
    </div>
  );
}

export function SessionShares() {
  const x0 = 120;
  const w = 500;
  const h = 40;
  return (
    <svg
      viewBox="0 0 640 170"
      role="img"
      aria-label="Two stacked bars. Clock: regular session 18.4%, pre and after hours 26.8%, overnight 22.7%, holiday 3.1%, weekend 29.0%. Dollars: regular 85.5%, pre and after hours 7.3%, overnight 7.1%, holiday 0.1%, weekend 0%."
    >
      {(["clock", "dollars"] as const).map((col, row) => {
        const y = 20 + row * 78;
        let x = x0;
        return (
          <g key={col}>
            <text className="f-display" x={0} y={y + h / 2 + 6} fontSize={22} fill={INK}>
              {row ? "Dollars" : "Clock"}
            </text>
            {SESSION_SHARES.map((k) => {
              const v = k[col];
              const ww = (w * v) / 100;
              const at = x;
              x += ww;
              if (ww <= 0) return null;
              return (
                <g key={k.name}>
                  <rect x={r2(at + 1)} y={y} width={r2(Math.max(1, ww - 2))} height={h} fill={k.color} rx={2} />
                  {ww > 46 && (
                    <text className="f-ui" x={r2(at + ww / 2)} y={y + h / 2 + 5} textAnchor="middle" fontSize={14} fontWeight={500} fill="#0b1733">
                      {v % 1 ? v.toFixed(1) : v}%
                    </text>
                  )}
                </g>
              );
            })}
            <text className="f-ui" x={x0 + w} y={y + h + 22} textAnchor="end" fontSize={13} fill={MUTED}>
              {row ? "Weekend: 0%" : "Weekend: 29% of the clock"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- p99 down-gaps ---------- */

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

/* deterministic decoration, same generator as the prototype */
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
    { t: 15.5, y: yDay(15.5), n: "1", label: "3:30 PM" },
    { t: 24.75, y: hz + 100, n: "2", label: "closed" },
    { t: 35, y: yDay(35), n: "3", label: "11:00 AM" },
  ];
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${mobile ? 300 : 250}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="One close drawn as a sky path. Afternoon on the left, the night as a dip below the horizon in the middle, the next morning on the right. Step 1 at 3:30 PM, step 2 through the night, step 3 at 11:00 AM."
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

/** Ballast's band model: a power law through the measured p99 gaps (4.4% at 17.5 h closed, 5.5% at 65.5 h). */
export const bandP99 = (hoursClosed: number) => (hoursClosed <= 0 ? 0 : 4.4 * Math.pow(hoursClosed / 17.5, 0.169));

export function OracleBand({ className }: { className?: string }) {
  const W = 700;
  const l = 56;
  const r = 64;
  const top = 24;
  const bot = 330;
  const T = 65.5;
  const x = (t: number) => l + (t / T) * (W - l - r);
  const k = (bot - top) / 2 / 7;
  const mid = (top + bot) / 2;
  const y = (p: number) => mid - p * k;
  let up = "";
  let dn = "";
  let lo = "";
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * T;
    const w = bandP99(t);
    up += (i ? "L" : "M") + f1(x(t)) + " " + f1(y(w));
    dn = `L${f1(x(t))} ${f1(y(-w))}` + dn;
    lo += (i ? "L" : "M") + f1(x(t)) + " " + f1(y(-w));
  }
  /* illustrative venue paths: one shared slow drift plus small venue offsets (deterministic) */
  const venues = [
    { n: "bStocks", c: "#f3ecd9", ph: 0, off: 0.12 },
    { n: "Ondo", c: "#bac7df", ph: 1.7, off: -0.18 },
    { n: "xStocks", c: "#8fa3c9", ph: 3.1, off: 0.05 },
  ];
  const common = (t: number) => -1.1 * Math.sin(t / 16) + 0.25 * Math.sin(t / 5.3) + (t > 52 ? -((t - 52) / 13.5) * 0.7 : 0);
  const paths = venues.map((v) => {
    let d = "";
    let val = 0;
    for (let i = 0; i <= 130; i++) {
      const t = (i / 130) * T;
      val = common(t) + v.off * Math.min(1, t / 6) + 0.12 * Math.sin(t / 2.4 + v.ph);
      d += (i ? "L" : "M") + f1(x(t)) + " " + f1(y(val));
    }
    return { ...v, d, end: y(val) };
  });
  const ends = paths.map((p) => ({ n: p.n, c: p.c, y: p.end })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 14) ends[i]!.y = ends[i - 1]!.y + 14;
  const ta = 41.3;
  const axis = (s: string, xx: number, yy: number, anchor: "start" | "middle" | "end" = "middle") => (
    <text className="f-ui" x={r2(xx)} y={r2(yy)} textAnchor={anchor} fontSize={12} fill={MUTED}>
      {s}
    </text>
  );
  return (
    <svg
      className={className}
      viewBox="0 0 700 380"
      role="img"
      aria-label="Chart from Friday 4 PM to Monday 9:30 AM. A band around the reference price widens from zero to plus or minus 5.5%. Three venue prices drift inside it."
    >
      {[-6, -4, -2, 0, 2, 4, 6].map((p) => (
        <g key={p}>
          <line x1={l} x2={W - r} y1={r2(y(p))} y2={r2(y(p))} stroke="#2a4677" strokeWidth={1} />
          {axis(`${p > 0 ? "+" : ""}${p}%`, l - 10, y(p) + 4, "end")}
        </g>
      ))}
      {(
        [
          [0, "Fri 4 PM"],
          [8, "Sat 0:00"],
          [32, "Sun 0:00"],
          [52, "Sun 8 PM"],
          [65.5, "Mon 9:30"],
        ] as const
      ).map(([t, s]) => (
        <g key={t}>
          <line x1={r2(x(t))} x2={r2(x(t))} y1={top} y2={bot} stroke="#2a4677" strokeWidth={1} />
          {axis(s, x(t), bot + 20, t === 0 ? "start" : t === T ? "end" : "middle")}
        </g>
      ))}
      <path d={up + dn + "Z"} fill="#3ef0b5" opacity={0.12} />
      <path d={up} fill="none" stroke="#3ef0b5" strokeWidth={1.5} />
      <path d={lo} fill="none" stroke="#3ef0b5" strokeWidth={1.5} />
      {paths.map((p) => (
        <path key={p.n} d={p.d} fill="none" stroke={p.c} strokeWidth={1.6} opacity={0.95} />
      ))}
      {ends.map((e) => (
        <text key={e.n} className="f-ui" x={W - r + 6} y={r2(e.y + 4)} fontSize={12} fill={e.c}>
          {e.n}
        </text>
      ))}
      <line x1={r2(x(ta))} x2={r2(x(ta))} y1={top} y2={bot} stroke={INK} strokeWidth={1} strokeDasharray="3 4" />
      <text className="f-ui" x={r2(x(ta) - 8)} y={top + 14} textAnchor="end" fontSize={13} fill={INK}>
        Reference age 41 h 18 min
      </text>
      <text className="f-ui" x={r2(x(ta) - 8)} y={top + 32} textAnchor="end" fontSize={13} fill="#3ef0b5">
        {`band \u00b1${bandP99(ta).toFixed(1)}%`}
      </text>
      <text className="f-display" x={r2(x(17.5))} y={r2(y(bandP99(17.5)) - 10)} textAnchor="middle" fontStyle="italic" fontSize={17} fill="#dfe5f1">
        {"\u00b14.4% after a night"}
      </text>
      <text className="f-display" x={r2(x(T) - 6)} y={r2(y(5.5) + 20)} textAnchor="end" fontStyle="italic" fontSize={17} fill="#dfe5f1">
        {"\u00b15.5% at the open"}
      </text>
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
