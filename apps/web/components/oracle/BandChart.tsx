"use client";
/* The chart of the explorer: a bStock's real hourly candles over one closure, against the band
   SessionAwareFeed enforces while New York is closed. Hours that traded outside the band are drawn in ember
   with a marker above them. Hover, or focus the plot and use the arrow keys, to read an hour; the table under
   the chart carries every value. */
import { localDay } from "@ballast/risk";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { nyDayTime } from "@/lib/format";
import type { BandPoint, ClosureChart, JudgedCandle } from "@/lib/market-view";
import { r2 } from "@/lib/planisphere/geometry";
import s from "./oracle.module.css";

const INK = { cream: "#f3ecd9", mint: "#3ef0b5", ember: "#ff9f80", grid: "#1c3463", rule: "#2a4677", muted: "#8fa3c9", surface: "#0b1733", caption: "#dfe5f1" };
const HOUR = 3600;
const pm = "\u00b1";

const money = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number, digits = 1) => `${(bps / 100).toFixed(digits)}%`;

function niceTicks(lo: number, hi: number, count = 5): { ticks: number[]; digits: number } {
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return { ticks, digits: step < 1 ? 2 : step < 10 && step % 1 !== 0 ? 1 : 0 };
}

/** What an hour did against the band, in words. */
export function verdict(k: JudgedCandle): string {
  if (k.place === "open") return "Regular session: the feed passes the price through.";
  if (k.place === "edge") return "This hour straddles the bell, so it is not judged.";
  if (!k.band || k.band.lo === null || k.band.hi === null) return "No anchor for the band at this hour.";
  if (!k.outside) return "Inside the band.";
  const side = k.h > k.band.hi ? "above" : "below";
  return `Traded ${pct(k.excessBps, 2)} ${side} the band${k.closedOutside ? " and closed outside it" : ", closed back inside"}.`;
}

export function chartSummary(c: ClosureChart): string {
  if (c.candles.length === 0) return "Binance returned no candles for this closure.";
  if (c.judged === 0) return c.bandNote ?? "No full hour of this closure has traded yet.";
  const hours = `${c.judged} full ${c.judged === 1 ? "hour" : "hours"} ${c.inProgress ? "so far" : "inside this closure"}`;
  if (c.outside === 0) return `${hours}: none traded outside the band.`;
  return `${hours}: ${c.outside} traded outside the band, ${c.closedOutside} closed outside it. For those hours the feed reads the band's edge, not the wick.`;
}

interface Geo {
  W: number;
  H: number;
  fm: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  x: (t: number) => number;
  y: (p: number) => number;
  ticks: number[];
  digits: number;
  bw: number;
}

function geometry(c: ClosureChart, compact: boolean): Geo {
  const W = compact ? 460 : 820;
  const H = compact ? 390 : 400;
  const fm = compact ? 1.3 : 1;
  const left = 58 * fm;
  const right = compact ? 14 : 22;
  const top = 34;
  const bottom = H - 44 * fm;
  const t0 = c.closedAt - 3 * HOUR;
  const t1 = c.opensAt + (c.inProgress ? HOUR / 2 : 3 * HOUR);
  const vals: number[] = [];
  for (const k of c.candles) vals.push(k.h, k.l);
  for (const b of c.band) if (b.lo !== null && b.hi !== null) vals.push(b.lo, b.hi);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const pad = (max - min || max * 0.02 || 1) * 0.07;
  const lo = min - pad;
  const hi = max + pad;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - right);
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);
  const { ticks, digits } = niceTicks(lo, hi);
  return { W, H, fm, left, right, top, bottom, x, y, ticks, digits, bw: Math.max(2, Math.min(11, (x(HOUR) - x(0)) * 0.6)) };
}

const line = (pts: readonly BandPoint[], g: Geo, edge: "lo" | "hi") => pts.map((p, i) => `${i ? "L" : "M"}${r2(g.x(p.t))} ${r2(g.y(p[edge] as number))}`).join("");
const area = (pts: readonly BandPoint[], g: Geo) =>
  pts.length < 2 ? "" : `${line(pts, g, "hi")}${[...pts].reverse().map((p) => `L${r2(g.x(p.t))} ${r2(g.y(p.lo as number))}`).join("")}Z`;

/** Runs of consecutive band points that have an anchor. */
function runs(pts: readonly BandPoint[]): BandPoint[][] {
  const out: BandPoint[][] = [];
  let cur: BandPoint[] = [];
  for (const p of pts) {
    if (p.lo === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function BandChart({ chart, symbol, now, dim = false }: { chart: ClosureChart; symbol: string; now: number; dim?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setCompact(el.getBoundingClientRect().width < 560);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setActive(null), [chart.closedAt, symbol]);

  const g = useMemo(() => geometry(chart, compact), [chart, compact]);
  const nowT = chart.inProgress ? Math.min(Math.max(now, chart.closedAt), chart.opensAt) : null;
  const { solid, projected } = useMemo(() => {
    if (nowT === null) return { solid: runs(chart.band), projected: [] as BandPoint[][] };
    return { solid: runs(chart.band.filter((p) => p.t <= nowT)), projected: runs(chart.band.filter((p) => p.t >= nowT - HOUR)) };
  }, [chart.band, nowT]);
  const days = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    for (let t = Math.ceil(chart.closedAt / HOUR) * HOUR; t < chart.opensAt; t += HOUR) {
      if (localDay(t).secondOfDay === 0) out.push({ t, label: nyDayTime(t).split(" ")[0] ?? "" });
    }
    return out;
  }, [chart.closedAt, chart.opensAt]);

  const candles = chart.candles;
  const hit = active !== null ? (candles[active] ?? null) : null;
  const first = chart.band.find((p) => p.hi !== null) ?? null;
  const last = [...chart.band].reverse().find((p) => p.hi !== null) ?? null;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (candles.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * g.W;
    let best = 0;
    let dist = Infinity;
    candles.forEach((k, i) => {
      const d = Math.abs(g.x(k.t + HOUR / 2) - px);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setActive(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (candles.length === 0) return;
    const end = candles.length - 1;
    const at = active ?? (e.key === "ArrowLeft" ? end + 1 : -1);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(end, at + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = end;
    else if (e.key === "Escape") setActive(null);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const label = `${symbol}B hourly candles from ${nyDayTime(chart.closedAt)} to ${nyDayTime(chart.opensAt)} New York, against the band the Session Oracle feed enforces. ${chartSummary(chart)}`;
  const F = (n: number) => r2(n * g.fm);
  const hx = hit ? g.x(hit.t + HOUR / 2) : 0;

  return (
    <div className={s.chartBox}>
      <div ref={wrap} className={s.plot} tabIndex={0} role="group" aria-label={`${label} Use the left and right arrow keys to read each hour.`} onKeyDown={onKey} onBlur={() => setActive(null)} data-dim={dim || undefined}>
        <svg viewBox={`0 0 ${g.W} ${g.H}`} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setActive(null)}>
          {g.ticks.map((v) => (
            <g key={v}>
              <line x1={g.left} x2={g.W - g.right} y1={r2(g.y(v))} y2={r2(g.y(v))} stroke={INK.grid} strokeWidth={1} />
              <text className="f-ui" x={g.left - 10} y={r2(g.y(v) + 4)} textAnchor="end" fontSize={F(12)} fill={INK.muted}>
                ${v.toFixed(g.digits)}
              </text>
            </g>
          ))}
          {days.map((d) => (
            <g key={d.t}>
              <line x1={r2(g.x(d.t))} x2={r2(g.x(d.t))} y1={g.top} y2={g.bottom} stroke={INK.grid} strokeWidth={1} />
              <text className="f-ui" x={r2(g.x(d.t) + 5)} y={g.bottom - 6} fontSize={F(11.5)} fill={INK.muted}>
                {d.label}
              </text>
            </g>
          ))}
          {[chart.closedAt, chart.opensAt].map((t, i) => (
            <g key={t}>
              <line x1={r2(g.x(t))} x2={r2(g.x(t))} y1={g.top} y2={g.bottom} stroke={INK.rule} strokeWidth={1} />
              <text className="f-ui" x={r2(g.x(t))} y={r2(g.bottom + 20 * g.fm)} textAnchor={i ? "end" : "start"} fontSize={F(12)} fill={INK.muted}>
                {nyDayTime(t)} {i ? "open" : "close"}
              </text>
            </g>
          ))}

          {solid.map((run, i) => (
            <g key={`s${i}`}>
              <path d={area(run, g)} fill={INK.mint} opacity={0.12} />
              <path d={line(run, g, "hi")} fill="none" stroke={INK.mint} strokeWidth={1.6} strokeLinejoin="round" />
              <path d={line(run, g, "lo")} fill="none" stroke={INK.mint} strokeWidth={1.6} strokeLinejoin="round" />
            </g>
          ))}
          {projected.map((run, i) => (
            <g key={`p${i}`} opacity={0.7}>
              <path d={area(run, g)} fill={INK.mint} opacity={0.06} />
              <path d={line(run, g, "hi")} fill="none" stroke={INK.mint} strokeWidth={1.2} strokeDasharray="4 5" />
              <path d={line(run, g, "lo")} fill="none" stroke={INK.mint} strokeWidth={1.2} strokeDasharray="4 5" />
            </g>
          ))}
          {first && first.hi !== null ? (
            <text className="f-display" x={r2(g.x(first.t) + 6)} y={r2(g.y(first.hi) - 8)} fontSize={F(15.5)} fontStyle="italic" fill={INK.caption}>
              {pm}
              {pct(first.bps)} at the close
            </text>
          ) : null}
          {last && last.hi !== null && last !== first ? (
            <text className="f-display" x={r2(g.x(last.t) - 6)} y={r2(g.y(last.hi) - 8)} textAnchor="end" fontSize={F(15.5)} fontStyle="italic" fill={INK.caption}>
              {pm}
              {pct(last.bps)} {chart.inProgress ? "by the open" : "at the open"}
            </text>
          ) : null}

          {candles.map((k, i) => {
            const cx = r2(g.x(k.t + HOUR / 2));
            const up = k.c >= k.o;
            const judged = k.place === "closed";
            const ink = k.outside ? INK.ember : INK.cream;
            const yo = g.y(Math.max(k.o, k.c));
            const h = Math.max(1.2, g.y(Math.min(k.o, k.c)) - yo);
            return (
              <g key={k.t} opacity={judged ? 1 : 0.4} data-candle={k.outside ? "outside" : k.place}>
                <line x1={cx} x2={cx} y1={r2(g.y(k.h))} y2={r2(g.y(k.l))} stroke={ink} strokeWidth={1} />
                <rect x={r2(cx - g.bw / 2)} y={r2(yo)} width={r2(g.bw)} height={r2(h)} fill={up ? INK.surface : ink} stroke={ink} strokeWidth={1} />
                {k.outside ? <path d={`M${r2(cx - 4)} ${r2(g.y(k.h) - 11)}h8l-4 7z`} fill={INK.ember} /> : null}
                {active === i ? <rect x={r2(cx - g.bw / 2 - 3)} y={r2(g.y(k.h) - 3)} width={r2(g.bw + 6)} height={r2(g.y(k.l) - g.y(k.h) + 6)} fill="none" stroke={INK.cream} strokeWidth={1} rx={2} /> : null}
              </g>
            );
          })}

          {nowT !== null ? (
            <g>
              <line x1={r2(g.x(nowT))} x2={r2(g.x(nowT))} y1={g.top - 8} y2={g.bottom} stroke={INK.mint} strokeWidth={1.5} />
              <path d={`M${r2(g.x(nowT) - 5)} ${g.top - 10}h10l-5 8z`} fill={INK.mint} />
              <text className="f-ui" x={r2(g.x(nowT) + (g.x(nowT) > g.W * 0.6 ? -9 : 9))} y={g.top - 14} textAnchor={g.x(nowT) > g.W * 0.6 ? "end" : "start"} fontSize={F(12.5)} fill={INK.cream}>
                now
              </text>
            </g>
          ) : null}
          {hit ? <line x1={r2(hx)} x2={r2(hx)} y1={g.top} y2={g.bottom} stroke={INK.muted} strokeWidth={1} opacity={0.7} pointerEvents="none" /> : null}
        </svg>
        {hit ? (
          <div className={s.tip} style={hx > g.W * 0.58 ? { right: `${r2(100 - (hx / g.W) * 100 + 2)}%` } : { left: `${r2((hx / g.W) * 100 + 2)}%` }} aria-hidden="true">
            <b>{nyDayTime(hit.t)} New York</b>
            <span>
              Open {money(hit.o)}, close {money(hit.c)}
            </span>
            <span>
              High {money(hit.h)}, low {money(hit.l)}
            </span>
            {hit.band && hit.band.lo !== null && hit.band.hi !== null ? (
              <span>
                Band {money(hit.band.lo)} to {money(hit.band.hi)} ({pm}
                {pct(hit.band.bps)})
              </span>
            ) : null}
            <i data-outside={hit.outside || undefined}>{verdict(hit)}</i>
          </div>
        ) : null}
      </div>
      <p className={s.readout} aria-live="polite">
        {hit ? `${nyDayTime(hit.t)}: open ${money(hit.o)}, high ${money(hit.h)}, low ${money(hit.l)}, close ${money(hit.c)}. ${verdict(hit)}` : chartSummary(chart)}
      </p>
      <div className={s.legend} aria-hidden="true">
        <span>
          <svg viewBox="0 0 14 16" width="14" height="16">
            <line x1="7" x2="7" y1="1" y2="15" stroke={INK.cream} />
            <rect x="3.5" y="4.5" width="7" height="7" fill={INK.surface} stroke={INK.cream} />
          </svg>
          Hour closed higher
        </span>
        <span>
          <svg viewBox="0 0 14 16" width="14" height="16">
            <line x1="7" x2="7" y1="1" y2="15" stroke={INK.cream} />
            <rect x="3.5" y="4.5" width="7" height="7" fill={INK.cream} stroke={INK.cream} />
          </svg>
          Hour closed lower
        </span>
        <span>
          <svg viewBox="0 0 22 16" width="22" height="16">
            <rect x="0" y="3" width="22" height="10" fill={INK.mint} opacity="0.14" />
            <line x1="0" x2="22" y1="3" y2="3" stroke={INK.mint} strokeWidth="1.6" />
            <line x1="0" x2="22" y1="13" y2="13" stroke={INK.mint} strokeWidth="1.6" />
          </svg>
          Band the feed enforces
        </span>
        <span>
          <svg viewBox="0 0 14 20" width="14" height="20">
            <path d="M3 1h8l-4 6z" fill={INK.ember} />
            <line x1="7" x2="7" y1="8" y2="19" stroke={INK.ember} />
            <rect x="3.5" y="10.5" width="7" height="6" fill={INK.ember} stroke={INK.ember} />
          </svg>
          Hour traded outside the band
        </span>
        <span>
          <svg viewBox="0 0 14 16" width="14" height="16" opacity="0.4">
            <line x1="7" x2="7" y1="1" y2="15" stroke={INK.cream} />
            <rect x="3.5" y="4.5" width="7" height="7" fill={INK.cream} stroke={INK.cream} />
          </svg>
          Regular session, no band
        </span>
      </div>
      <details className={s.tableTwin}>
        <summary>Show the hours as a table</summary>
        <div className={s.tableScroll}>
          <table>
            <thead>
              <tr>
                <th scope="col">Hour (New York)</th>
                <th scope="col">Open</th>
                <th scope="col">High</th>
                <th scope="col">Low</th>
                <th scope="col">Close</th>
                <th scope="col">Band low</th>
                <th scope="col">Band high</th>
                <th scope="col">Against the band</th>
              </tr>
            </thead>
            <tbody>
              {candles.map((k) => (
                <tr key={k.t} data-outside={k.outside || undefined}>
                  <th scope="row">{nyDayTime(k.t)}</th>
                  <td>{money(k.o)}</td>
                  <td>{money(k.h)}</td>
                  <td>{money(k.l)}</td>
                  <td>{money(k.c)}</td>
                  <td>{k.band && k.band.lo !== null ? money(k.band.lo) : "none"}</td>
                  <td>{k.band && k.band.hi !== null ? money(k.band.hi) : "none"}</td>
                  <td>{verdict(k)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
