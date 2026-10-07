"use client";
/* Star tooltip and the delegated pointer/focus/keyboard handling shared by every interactive wheel.
   Stars carry data-star = index into the liquidations array, so one set of handlers serves 121 stars.
   Mouse: hover shows the tip, click opens BscScan. Touch: the first tap shows the tip, a second tap on the
   same star opens it. Keyboard: focus shows the tip, Enter follows the link. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Liquidation } from "@/lib/planisphere/types";
import { bscscanTx } from "./Wheel";

const SESSION: Record<Liquidation["s"], string> = {
  regular: "Regular session",
  pre: "Pre-market",
  post: "After hours",
  overnight: "Overnight",
  holiday: "Holiday",
  weekend: "Weekend",
};
const GROUP: Record<Liquidation["g"], string> = {
  organic: "Organic borrower",
  seed: "Tripwire test address",
  loan: "bStock was the loan asset",
};

type Via = "pointer" | "touch" | "focus";

export interface TipState {
  r: Liquidation;
  /** the star the tip belongs to, so it can follow the page as it scrolls */
  el: Element;
  left: number;
  top: number;
  via: Via;
  /** false while fading out; the last content stays in place */
  open: boolean;
}

export const starIndexOf = (target: EventTarget | null): number | null => {
  const el = target instanceof Element ? target.closest("[data-star]") : null;
  return el ? Number(el.getAttribute("data-star")) : null;
};

/* fixed position next to a star, kept inside the viewport */
function place(r: Liquidation, el: Element, via: Via): TipState {
  const b = el.getBoundingClientRect();
  return { r, el, via, left: Math.min(window.innerWidth - 240, Math.max(8, b.left + 14)), top: Math.max(8, b.top - 112), open: true };
}

export interface StarTipOptions {
  /** stars are <a href> links (the browser opens them); otherwise a click opens BscScan from script */
  links?: boolean;
}

/** Tooltip state plus delegated handlers to spread on the <svg> that holds the stars. */
export function useStarTip(liquidations: readonly Liquidation[], { links = false }: StarTipOptions = {}) {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<TipState | null>(null);
  const pointerType = useRef<string>("mouse");
  useEffect(() => {
    tipRef.current = tip;
  }, [tip]);

  const show = useCallback(
    (target: EventTarget | null, via: Via) => {
      const i = starIndexOf(target);
      const r = i === null ? undefined : liquidations[i];
      if (!r || !(target instanceof Element)) return;
      setTip(place(r, target.closest("[data-star]")!, via));
    },
    [liquidations],
  );
  const hide = useCallback(() => setTip((t) => (t && t.open ? { ...t, open: false } : t)), []);

  const handlers = useMemo(
    () => ({
      onPointerOver: (e: PointerEvent<SVGSVGElement>) => {
        if (e.pointerType !== "touch" && starIndexOf(e.target) !== null) show(e.target, "pointer");
      },
      onPointerOut: (e: PointerEvent<SVGSVGElement>) => {
        if (e.pointerType === "touch") return;
        const from = starIndexOf(e.target);
        if (from !== null && starIndexOf(e.relatedTarget) !== from) hide();
      },
      onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
        pointerType.current = e.pointerType;
      },
      onFocus: (e: FocusEvent<SVGSVGElement>) => {
        if (starIndexOf(e.target) !== null) show(e.target, "focus");
      },
      onBlur: (e: FocusEvent<SVGSVGElement>) => {
        if (starIndexOf(e.target) !== null) hide();
      },
      onClick: (e: MouseEvent<SVGSVGElement>) => {
        const i = starIndexOf(e.target);
        const r = i === null ? undefined : liquidations[i];
        const touch = e.detail > 0 && pointerType.current === "touch";
        if (!r) {
          if (touch) hide();
          return;
        }
        const current = tipRef.current;
        if (touch && !(current?.open && current.r === r)) {
          e.preventDefault();
          show(e.target, "touch");
          return;
        }
        if (!links) window.open(bscscanTx(r.tx), "_blank", "noopener");
      },
    }),
    [show, hide, links, liquidations],
  );

  // keep the fixed tip on its star while the page scrolls (focusing a star scrolls it into view)
  const open = tip?.open ?? false;
  useEffect(() => {
    if (!open) return;
    const follow = () => setTip((t) => (t && t.open ? place(t.r, t.el, t.via) : t));
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

const HOW_TO_OPEN: Record<Via, string> = {
  pointer: "Click to open on BscScan",
  touch: "Tap again to open on BscScan",
  focus: "Press Enter to open on BscScan",
};

export function StarTip({ tip, links = false }: { tip: TipState | null; links?: boolean }) {
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
        {r.holiday ? `Holiday (${r.holiday})` : SESSION[r.s]}
        {r.first90 ? ", first 90 minutes" : ""}
      </div>
      <div>{GROUP[r.g]}</div>
      <div>{tip.via === "focus" && !links ? HOW_TO_OPEN.pointer : HOW_TO_OPEN[tip.via]}</div>
    </div>,
    document.body,
  );
}
