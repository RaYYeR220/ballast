"use client";
/* <Planisphere>: the New York week as a star wheel you can turn.
   - the mint meridian at the top is "now"; the wheel follows New York's clock (360 deg per 168 h), checked each minute
   - on load the sky sweeps the last 30 hours into place, unless the reader prefers reduced motion
   - drag to scrub; as a slider it takes Arrow keys (1 h), PageUp/PageDown (1 day), Home/End
   - sessions come from the NYSE calendar in @ballast/risk, so holidays and early closes show on the ring */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { hourAtTop, r2, radiusForUsd, rotationFor, shortestTurn, WEEK_HOURS, wrapHour } from "@/lib/planisphere/geometry";
import { hourOfWeek, meridianReadout, mondayOf, sectorsOfWeek, typicalWeekSectors } from "@/lib/planisphere/sessions";
import type { ClosureWindow, Liquidation } from "@/lib/planisphere/types";
import { StarTip, starIndexOf, useStarTip } from "./StarTip";
import { bscscanTx, SKY, WheelDefs, WheelSky } from "./Wheel";
import styles from "./Planisphere.module.css";

const Sky = memo(WheelSky);

const SWEEP_MS = 2200;
const SWEEP_HOURS = 30;
const RETURN_TO_NOW_MS = 60_000;
const COMPACT_QUERY = "(max-width: 959.98px)";

export interface DialGeometry {
  /** viewBox size in px (the svg is drawn 1:1) */
  size: number;
  R: number;
  compact: boolean;
}

export interface PlanisphereProps {
  liquidations: readonly Liquidation[];
  /** unix seconds for the meridian; omit to follow the live New York clock */
  now?: number;
  /** a closure window to mark on the wheel, e.g. from nextWindow() in @ballast/risk */
  window?: ClosureWindow | null;
  /** called with the hour of the week under the meridian whenever the reader turns the wheel */
  onScrub?: (hourOfWeek: number) => void;
  /** "card": the printed planisphere aperture of the landing hero; "plain": the app's wheel */
  frame?: "card" | "plain";
  /** italic caption running along the aperture (card frame) */
  caption?: string;
  /** accessible name of the dial */
  label: string;
  /** the page-load sweep of the last 30 hours (skipped for reduced motion) */
  sweep?: boolean;
  starOpacity?: number;
  /** wheel-space marks that turn with the sky (shield, restore, refusal) */
  marks?: (geo: DialGeometry) => ReactNode;
  className?: string;
  svgClassName?: string;
  readoutClassName?: string;
}

const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);

export function Planisphere({
  liquidations,
  now,
  window: closure = null,
  onScrub,
  frame = "plain",
  caption,
  label,
  sweep = true,
  starOpacity,
  marks,
  className,
  svgClassName,
  readoutClassName,
}: PlanisphereProps) {
  const id = "pl" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<number | null>(null);
  const [compact, setCompact] = useState(false);
  const [liveNow, setLiveNow] = useState<number | null>(null);
  const [rot, setRot] = useState(0);
  const [dragging, setDragging] = useState(false);
  const rotRef = useRef(0);
  const sweepFrame = useRef<number | null>(null);
  const swept = useRef(false);
  const lastScrub = useRef(-Infinity);
  const drag = useRef<{ a0: number; r0: number } | null>(null);
  const { tip, handlers: tipHandlers, hide: hideTip } = useStarTip(liquidations);

  const ts = now ?? liveNow;
  const nowH = ts === null ? null : hourOfWeek(ts);
  const monday = ts === null ? null : mondayOf(ts);
  // the ring only changes when the week does
  const sectors = useMemo(() => (monday === null ? typicalWeekSectors() : sectorsOfWeek(monday)), [monday]);

  const apply = useCallback((deg: number) => {
    rotRef.current = deg;
    setRot(deg);
  }, []);
  const stopSweep = useCallback(() => {
    if (sweepFrame.current !== null) cancelAnimationFrame(sweepFrame.current);
    sweepFrame.current = null;
  }, []);

  // size the drawing to the element, like the prototype (text and strokes stay in px)
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const mq = window.matchMedia(COMPACT_QUERY);
    const measure = () => {
      const w = Math.round(svg.getBoundingClientRect().width);
      if (w > 0) setSize(w);
      setCompact(mq.matches);
    };
    measure();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(measure, 150);
    });
    ro.observe(svg);
    mq.addEventListener("change", measure);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      mq.removeEventListener("change", measure);
    };
  }, []);

  // the live clock: New York time, re-read each minute
  useEffect(() => {
    if (now !== undefined) return;
    const tick = () => setLiveNow(Math.floor(Date.now() / 1000));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [now]);

  const ready = size !== null && nowH !== null;

  // first: sweep into place; afterwards: follow the clock unless the reader is exploring
  useEffect(() => {
    if (!ready || nowH === null) return;
    const target = rotationFor(nowH);
    if (!swept.current) {
      swept.current = true;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!sweep || still) {
        apply(target);
        return;
      }
      const from = rotationFor(nowH - SWEEP_HOURS);
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.max(0, Math.min(1, (t - t0) / SWEEP_MS));
        apply(from + (target - from) * easeOutCubic(k));
        sweepFrame.current = k < 1 ? requestAnimationFrame(step) : null;
      };
      apply(from);
      sweepFrame.current = requestAnimationFrame(step);
      // interrupted before it finished (unmount, or a new minute): run it again next time
      return () => {
        if (sweepFrame.current === null) return;
        stopSweep();
        swept.current = false;
      };
    }
    if (drag.current || sweepFrame.current !== null) return;
    if (performance.now() - lastScrub.current < RETURN_TO_NOW_MS) return;
    apply(rotRef.current + shortestTurn(rotRef.current, target));
  }, [ready, nowH, sweep, apply, stopSweep]);

  const scrubTo = useCallback(
    (deg: number) => {
      stopSweep();
      apply(deg);
      lastScrub.current = performance.now();
      onScrub?.(hourAtTop(deg));
    },
    [apply, onScrub, stopSweep],
  );

  const pointerAngle = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return (Math.atan2(e.clientY - b.top - b.height / 2, e.clientX - b.left - b.width / 2) * 180) / Math.PI;
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!ready || e.button !== 0 || starIndexOf(e.target) !== null) return;
    stopSweep();
    drag.current = { a0: pointerAngle(e), r0: rotRef.current };
    setDragging(true);
    hideTip();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current) scrubTo(drag.current.r0 + pointerAngle(e) - drag.current.a0);
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    lastScrub.current = performance.now();
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!ready || e.target !== e.currentTarget) return;
    const h = hourAtTop(rotRef.current);
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 24, PageDown: -24 };
    let next: number;
    if (e.key in steps) {
      const d = steps[e.key]!;
      next = (d > 0 ? Math.floor(h + 1e-6) : Math.ceil(h - 1e-6)) + d;
    } else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = WEEK_HOURS - 1;
    else return;
    e.preventDefault();
    scrubTo(rotRef.current + shortestTurn(rotRef.current, rotationFor(wrapHour(next))));
  };

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const i = starIndexOf(e.target);
    const r = i === null ? undefined : liquidations[i];
    if (r) window.open(bscscanTx(r.tx), "_blank", "noopener");
  };

  const S = size ?? 0;
  const c = S / 2;
  const R = frame === "card" ? (S / 2 / 1.12) * 0.93 : S / 2 - 18;
  const geo = useMemo<DialGeometry>(() => ({ size: S, R, compact }), [S, R, compact]);
  const marksNode = useMemo(() => (ready && marks ? marks(geo) : null), [ready, marks, geo]);
  const win = useMemo(() => {
    if (!closure) return null;
    const h0 = hourOfWeek(closure.startsAt);
    const span = Math.min(WEEK_HOURS - 0.01, Math.max(0, (closure.endsAt - closure.startsAt) / 3600));
    return { h0, h1: h0 + span };
  }, [closure]);

  const top = hourAtTop(rot);
  const readout = ready ? meridianReadout(sectors, top) : "";

  return (
    <div className={[styles.root, className].filter(Boolean).join(" ")}>
      <svg
        ref={svgRef}
        className={[styles.svg, svgClassName ?? styles.fill].filter(Boolean).join(" ")}
        viewBox={`0 0 ${S || 1} ${S || 1}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={WEEK_HOURS}
        aria-valuenow={Math.round(top * 100) / 100}
        aria-valuetext={readout || undefined}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onClick={onClick}
        {...tipHandlers}
      >
        {ready && (
          <>
            <WheelDefs id={id} compact={compact} />
            <g transform={`translate(${r2(c)},${r2(c)})`}>
              <circle r={R + (compact ? 8 : 14)} fill="none" stroke={SKY.p500} strokeWidth={1} opacity={0.6} />
              <g transform={`rotate(${r2(rot)})`}>
                <Sky id={id} R={R} sectors={sectors} liquidations={liquidations} compact={compact} starOpacity={starOpacity} window={win} />
                {marksNode}
              </g>
            </g>
            {frame === "card" ? <CardFrame id={id} c={c} R={R} compact={compact} caption={caption} /> : <PlainMeridian c={c} R={R} />}
          </>
        )}
      </svg>
      <p className={readoutClassName ?? styles.readout} aria-hidden="true">
        {readout}
      </p>
      <StarTip tip={tip} />
    </div>
  );
}

/** The printed planisphere: a cream annulus over the wheel, a soft inset shadow, a curved caption. */
function CardFrame({ id, c, R, compact, caption }: { id: string; c: number; R: number; compact: boolean; caption?: string }) {
  const ap = R * 1.035;
  const ao = ap + 60;
  const arcR = ap + 22;
  const ring = (r: number) =>
    `M${r2(c + r)} ${r2(c)}A${r2(r)} ${r2(r)} 0 1 0 ${r2(c - r)} ${r2(c)}A${r2(r)} ${r2(r)} 0 1 0 ${r2(c + r)} ${r2(c)}Z`;
  return (
    <g pointerEvents="none">
      <defs>
        <filter id={`${id}cut`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={compact ? 3 : 5} />
        </filter>
      </defs>
      <circle cx={c} cy={c} r={r2(ap + 2)} fill="none" stroke="#000" opacity={0.45} strokeWidth={compact ? 6 : 10} filter={`url(#${id}cut)`} />
      <path d={`${ring(ao)} ${ring(ap)}`} fill="#faf6ea" fillRule="evenodd" />
      <circle cx={c} cy={c} r={r2(ap)} fill="none" stroke="#3b331f" strokeWidth={1.2} />
      <circle cx={c} cy={c} r={r2(ap + 8)} fill="none" stroke="#a8986f" strokeWidth={0.8} />
      <line x1={c} x2={c} y1={r2(c - ap - 18)} y2={r2(c - R * 0.16)} stroke="#0b7a5a" strokeWidth={1.5} />
      <path d={`M${r2(c - 6)} ${r2(c - ap - 20)}h12l-6 10z`} fill="#0b7a5a" />
      {!compact &&
        [10, 100, 1000, 10000].map((u) => (
          <text key={u} className="f-ui" x={r2(c + 6)} y={r2(c - radiusForUsd(u, R) - 4)} fontSize={10.5} fill={SKY.p200} opacity={0.85}>
            {u >= 1000 ? `$${u / 1000}k` : `$${u}`}
          </text>
        ))}
      {caption && (
        <>
          <path id={`${id}arc`} d={`M${r2(c - arcR)} ${r2(c)} A${r2(arcR)} ${r2(arcR)} 0 0 0 ${r2(c + arcR)} ${r2(c)}`} fill="none" />
          <text className="f-display" fontStyle="italic" fontSize={compact ? 12 : 15} fill="#6f6142" textAnchor="middle">
            <textPath href={`#${id}arc`} startOffset="50%">
              {caption}
            </textPath>
          </text>
        </>
      )}
    </g>
  );
}

function PlainMeridian({ c, R }: { c: number; R: number }) {
  return (
    <g pointerEvents="none">
      <line x1={c} x2={c} y1={r2(c - R - 14)} y2={r2(c - R * 0.62)} stroke={SKY.mint} strokeWidth={1.5} />
      <path d={`M${r2(c - 5)} ${r2(c - R - 16)}h10l-5 9z`} fill={SKY.mint} />
    </g>
  );
}
