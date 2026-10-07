"use client";
/* <Planisphere>: the New York week as a star wheel you can turn.
   - the mint meridian at the top is "now"; the wheel follows New York's clock (360 deg per 168 h), read on each minute
   - on load the sky sweeps the last 30 hours into place, unless the reader prefers reduced motion
   - mouse and pen turn it by angle; a finger turns it by dragging sideways, so a vertical swipe still scrolls the page
   - as a slider it takes Arrow keys (1 h), PageUp/PageDown (1 day), Home/End
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
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { hourAtTop, r2, radiusForUsd, rotationFor, shortestTurn, WEEK_HOURS, wrapHour } from "@/lib/planisphere/geometry";
import { hourOfWeek, meridianReadout, mondayOf, sectorsOfWeek, TYPICAL_WEEK_TS, tsOfHour } from "@/lib/planisphere/sessions";
import type { ClosureWindow, Liquidation, ScrubPoint } from "@/lib/planisphere/types";
import { StarTip, starIndexOf, useStarTip } from "./StarTip";
import { SKY, WheelDefs, WheelSky } from "./Wheel";
import styles from "./Planisphere.module.css";

const Sky = memo(WheelSky);

const SWEEP_MS = 2200;
const SWEEP_HOURS = 30;
const RETURN_TO_NOW_MS = 60_000;
const COMPACT_BELOW_PX = 480;
/** a finger has to travel this far, and more sideways than down, before the dial takes the gesture */
const TOUCH_SLOP_PX = 8;

export interface DialGeometry {
  /** viewBox size in px (the svg is drawn 1:1) */
  size: number;
  R: number;
  compact: boolean;
}

export interface PlanisphereProps {
  liquidations: readonly Liquidation[];
  /** unix seconds for the meridian; omit to follow the live New York clock. A new value always re-centres the dial. */
  now?: number;
  /** after the reader turns the dial, drift back to now (60 s after the last turn, never while focused) */
  followNow?: boolean;
  /** a closure window to mark on the wheel, e.g. from nextWindow() in @ballast/risk */
  window?: ClosureWindow | null;
  /** called whenever the reader turns the wheel */
  onScrub?: (point: ScrubPoint) => void;
  /** "card": the printed planisphere aperture of the landing hero; "plain": the app's wheel */
  frame?: "card" | "plain";
  /** italic caption running along the aperture (card frame) */
  caption?: string;
  /** accessible name of the dial */
  label: string;
  /** small labels and stars; by default when the drawing is narrower than 480 px */
  compact?: boolean;
  /** the page-load sweep of the last 30 hours (skipped for reduced motion) */
  sweep?: boolean;
  starOpacity?: number;
  /** wheel-space marks that turn with the sky (shield, restore, refusal) */
  marks?: (geo: DialGeometry) => ReactNode;
  className?: string;
  svgClassName?: string;
  readoutClassName?: string;
  hintClassName?: string;
}

const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);

/** Wheel hours of a closure; the end is read on the clock, so a DST change inside it does not stretch the arc. */
export function closureHours(w: ClosureWindow): { h0: number; h1: number } {
  const h0 = hourOfWeek(w.startsAt);
  let h1 = hourOfWeek(w.endsAt);
  if (h1 <= h0) h1 += WEEK_HOURS;
  return { h0, h1 };
}

interface TouchGesture {
  id: number;
  x0: number;
  y0: number;
  r0: number;
  width: number;
  active: boolean;
}

export function Planisphere({
  liquidations,
  now,
  followNow = true,
  window: closure = null,
  onScrub,
  frame = "plain",
  caption,
  label,
  compact: compactProp,
  sweep = true,
  starOpacity,
  marks,
  className,
  svgClassName,
  readoutClassName,
  hintClassName,
}: PlanisphereProps) {
  const id = "pl" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<number | null>(null);
  const [liveNow, setLiveNow] = useState<number | null>(null);
  const [rot, setRot] = useState(0);
  const [dragging, setDragging] = useState(false);
  const rotRef = useRef(0);
  const sweepFrame = useRef<number | null>(null);
  const swept = useRef(false);
  const lastScrub = useRef(-Infinity);
  const focused = useRef(false);
  const drag = useRef<{ a0: number; r0: number } | null>(null);
  const touch = useRef<TouchGesture | null>(null);
  const swallowClick = useRef(false);
  const { tip, handlers: tipHandlers, hide: hideTip } = useStarTip(liquidations);

  const ts = now ?? liveNow;
  const nowH = ts === null ? null : hourOfWeek(ts);
  const nowHRef = useRef(nowH);
  useLayoutEffect(() => {
    nowHRef.current = nowH;
  });
  // until the clock is read, a plain week; the ring only changes when the week does
  const monday = mondayOf(ts ?? TYPICAL_WEEK_TS);
  const sectors = useMemo(() => sectorsOfWeek(monday), [monday]);
  const compact = compactProp ?? (size !== null && size < COMPACT_BELOW_PX);

  const apply = useCallback((deg: number) => {
    rotRef.current = deg;
    setRot(deg);
  }, []);
  const stopSweep = useCallback(() => {
    if (sweepFrame.current !== null) cancelAnimationFrame(sweepFrame.current);
    sweepFrame.current = null;
  }, []);
  const centre = useCallback((h: number) => apply(rotRef.current + shortestTurn(rotRef.current, rotationFor(h))), [apply]);

  // size the drawing to the element (text and strokes stay in px)
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const w = Math.round(svg.getBoundingClientRect().width);
      if (w > 0) setSize(w);
    };
    measure();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(measure, 150);
    });
    ro.observe(svg);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  // the live clock, read on each minute boundary
  useEffect(() => {
    if (now !== undefined) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const ms = Date.now();
      setLiveNow(Math.floor(ms / 1000));
      t = setTimeout(tick, 60_000 - (ms % 60_000) + 20);
    };
    tick();
    return () => clearTimeout(t);
  }, [now]);

  const ready = size !== null && nowH !== null;

  // first placement: sweep the last 30 hours into place
  useEffect(() => {
    if (!ready || swept.current || nowHRef.current === null) return;
    swept.current = true;
    const target = () => rotationFor(nowHRef.current ?? 0);
    if (!sweep || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      apply(target());
      return;
    }
    const from = rotationFor(nowHRef.current - SWEEP_HOURS);
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.max(0, Math.min(1, (t - t0) / SWEEP_MS));
      apply(from + (target() - from) * easeOutCubic(k));
      sweepFrame.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    apply(from);
    sweepFrame.current = requestAnimationFrame(step);
    // interrupted before it finished (unmount): run it again next time
    return () => {
      if (sweepFrame.current === null) return;
      stopSweep();
      swept.current = false;
    };
  }, [ready, sweep, apply, stopSweep]);

  // a new controlled `now` always re-centres
  const prevNow = useRef(now);
  useEffect(() => {
    if (prevNow.current === now) return;
    prevNow.current = now;
    if (now === undefined || !swept.current) return;
    stopSweep();
    drag.current = null;
    touch.current = null;
    setDragging(false);
    centre(hourOfWeek(now));
  }, [now, centre, stopSweep]);

  // the live clock moved: follow it unless the reader is exploring
  useEffect(() => {
    if (now !== undefined || nowH === null || !swept.current || !followNow) return;
    if (drag.current || touch.current?.active || focused.current || sweepFrame.current !== null) return;
    if (performance.now() - lastScrub.current < RETURN_TO_NOW_MS) return;
    centre(nowH);
  }, [nowH, now, followNow, centre]);

  const scrubTo = useCallback(
    (deg: number) => {
      stopSweep();
      apply(deg);
      lastScrub.current = performance.now();
      const h = hourAtTop(deg);
      onScrub?.({ hourOfWeek: h, ts: tsOfHour(monday, h) });
    },
    [apply, onScrub, stopSweep, monday],
  );

  const pointerAngle = (e: PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return (Math.atan2(e.clientY - b.top - b.height / 2, e.clientX - b.left - b.width / 2) * 180) / Math.PI;
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    tipHandlers.onPointerDown(e);
    if (!ready || e.button !== 0) return;
    if (e.pointerType === "touch") {
      // wait: the page keeps vertical swipes (touch-action: pan-y), the dial takes sideways ones
      touch.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, r0: rotRef.current, width: e.currentTarget.getBoundingClientRect().width || 1, active: false };
      return;
    }
    if (starIndexOf(e.target) !== null) return;
    stopSweep();
    drag.current = { a0: pointerAngle(e), r0: rotRef.current };
    setDragging(true);
    hideTip();
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const g = touch.current;
    if (g && e.pointerId === g.id) {
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.active) {
        if (Math.abs(dx) <= TOUCH_SLOP_PX || Math.abs(dx) <= Math.abs(dy)) return;
        g.active = true;
        setDragging(true);
        hideTip();
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      scrubTo(g.r0 + (dx / g.width) * 180);
      return;
    }
    if (drag.current) scrubTo(drag.current.r0 + pointerAngle(e) - drag.current.a0);
  };

  const endGesture = (e: PointerEvent<SVGSVGElement>) => {
    const g = touch.current;
    if (g && e.pointerId === g.id) {
      touch.current = null;
      if (g.active) {
        swallowClick.current = e.type === "pointerup";
        setDragging(false);
        lastScrub.current = performance.now();
      }
      return;
    }
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    lastScrub.current = performance.now();
  };

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    tipHandlers.onClick(e);
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

  const onFocus = (e: FocusEvent<SVGSVGElement>) => {
    if (e.target === e.currentTarget) focused.current = true;
    tipHandlers.onFocus(e);
  };
  const onBlur = (e: FocusEvent<SVGSVGElement>) => {
    if (e.target === e.currentTarget) focused.current = false;
    tipHandlers.onBlur(e);
  };

  const S = size ?? 0;
  const c = S / 2;
  const R = frame === "card" ? (S / 2 / 1.12) * 0.93 : S / 2 - 18;
  const geo = useMemo<DialGeometry>(() => ({ size: S, R, compact }), [S, R, compact]);
  const marksNode = useMemo(() => (ready && marks ? marks(geo) : null), [ready, marks, geo]);
  const win = useMemo(() => (closure ? closureHours(closure) : null), [closure]);

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
        onPointerOver={tipHandlers.onPointerOver}
        onPointerOut={tipHandlers.onPointerOut}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
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
      <p className={[styles.hint, hintClassName].filter(Boolean).join(" ")} aria-hidden="true">
        Drag sideways to turn
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
