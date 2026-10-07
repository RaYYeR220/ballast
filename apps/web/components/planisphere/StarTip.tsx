"use client";
/* Star tooltip and the delegated pointer/focus/keyboard handling shared by every interactive wheel.
   Stars carry data-star = index into the liquidations array, so one set of handlers serves 121 stars. */
import { useCallback, useEffect, useMemo, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Liquidation } from "@/lib/planisphere/types";

const SESSION: Record<Liquidation["s"], string> = {
  regular: "Regular session",
  pre: "Pre-market",
  post: "After hours",
  overnight: "Overnight",
  holiday: "Holiday (Juneteenth)",
  weekend: "Weekend",
};
const GROUP: Record<Liquidation["g"], string> = {
  organic: "Organic borrower",
  seed: "Tripwire test address",
  loan: "bStock was the loan asset",
};

export interface TipState {
  r: Liquidation;
  /** the star the tip belongs to, so it can follow the page as it scrolls */
  el: Element;
  left: number;
  top: number;
  /** false while fading out; the last content stays in place */
  open: boolean;
}

/* fixed position next to a star, kept inside the viewport (prototype placement) */
function place(r: Liquidation, el: Element, open: boolean): TipState {
  const b = el.getBoundingClientRect();
  return { r, el, left: Math.min(window.innerWidth - 240, Math.max(8, b.left + 14)), top: Math.max(8, b.top - 112), open };
}

export const starIndexOf = (target: EventTarget | null): number | null => {
  const el = target instanceof Element ? target.closest("[data-star]") : null;
  return el ? Number(el.getAttribute("data-star")) : null;
};

/** Tooltip state plus delegated handlers to spread on the <svg> that holds the stars. */
export function useStarTip(liquidations: readonly Liquidation[]) {
  const [tip, setTip] = useState<TipState | null>(null);

  const show = useCallback(
    (target: EventTarget | null) => {
      const i = starIndexOf(target);
      const r = i === null ? undefined : liquidations[i];
      if (!r || !(target instanceof Element)) return;
      setTip(place(r, target.closest("[data-star]")!, true));
    },
    [liquidations],
  );
  const hide = useCallback(() => setTip((t) => (t && t.open ? { ...t, open: false } : t)), []);

  const handlers = useMemo(
    () => ({
      onPointerOver: (e: PointerEvent<SVGSVGElement>) => {
        if (starIndexOf(e.target) !== null) show(e.target);
      },
      onPointerOut: (e: PointerEvent<SVGSVGElement>) => {
        const from = starIndexOf(e.target);
        if (from !== null && starIndexOf(e.relatedTarget) !== from) hide();
      },
      onFocus: (e: FocusEvent<SVGSVGElement>) => {
        if (starIndexOf(e.target) !== null) show(e.target);
      },
      onBlur: (e: FocusEvent<SVGSVGElement>) => {
        if (starIndexOf(e.target) !== null) hide();
      },
    }),
    [show, hide],
  );

  // keep the fixed tip on its star while the page scrolls (focusing a star scrolls it into view)
  const open = tip?.open ?? false;
  useEffect(() => {
    if (!open) return;
    const follow = () => setTip((t) => (t && t.open ? place(t.r, t.el, true) : t));
    window.addEventListener("scroll", follow, { passive: true });
    return () => window.removeEventListener("scroll", follow);
  }, [open]);

  return { tip, handlers, hide };
}

/** Roving focus over the stars in time order: one tab stop, arrow keys walk the week. */
export function useStarRoving(liquidations: readonly Liquidation[]) {
  const timeOrder = useMemo(() => liquidations.map((_, i) => i).sort((a, b) => liquidations[a]!.h - liquidations[b]!.h), [liquidations]);
  const [active, setActive] = useState<number>(() => timeOrder[0] ?? 0);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<SVGSVGElement>) => {
      const i = starIndexOf(e.target);
      if (i === null) return;
      const pos = timeOrder.indexOf(i);
      const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      let next: number | undefined;
      if (e.key in step) next = timeOrder[(pos + step[e.key]! + timeOrder.length) % timeOrder.length];
      else if (e.key === "Home") next = timeOrder[0];
      else if (e.key === "End") next = timeOrder[timeOrder.length - 1];
      if (next === undefined) return;
      e.preventDefault();
      setActive(next);
      const el = e.currentTarget.querySelector<SVGElement>(`[data-star="${next}"]`);
      el?.focus();
    },
    [timeOrder],
  );

  return { active, onKeyDown };
}

export function StarTip({ tip }: { tip: TipState | null }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !tip) return null;
  const { r } = tip;
  return createPortal(
    <div className="star-tip" role="tooltip" aria-hidden={!tip.open} style={{ left: tip.left, top: tip.top, opacity: tip.open ? 1 : 0 }}>
      <b>
        ${r.usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} repaid, {r.c}
      </b>
      <div>{r.et}</div>
      <div>
        {SESSION[r.s]}
        {r.t.includes("first 90") ? ", first 90 minutes" : ""}
      </div>
      <div>{GROUP[r.g]}</div>
      <div>Click to open on BscScan</div>
    </div>,
    document.body,
  );
}
