"use client";
/* Closing dome: the wheel rising from the bottom of the last section, turned to now, under a field of faint stars. */
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { StarTip, starIndexOf, useStarTip } from "@/components/planisphere/StarTip";
import { bscscanTx, SKY, Wheel } from "@/components/planisphere/Wheel";
import { r2, rotationFor } from "@/lib/planisphere/geometry";
import { hourOfWeek, weekSectors } from "@/lib/planisphere/sessions";
import { LIQUIDATIONS } from "@/lib/liquidations";

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

interface Box {
  W: number;
  H: number;
  now: number;
}

export function ClosingSky({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const { tip, handlers } = useStarTip(LIQUIDATIONS);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const b = svg.getBoundingClientRect();
      if (b.width > 0) setBox({ W: Math.round(b.width), H: Math.round(b.height), now: Math.floor(Date.now() / 1000) });
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

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const i = starIndexOf(e.target);
    const r = i === null ? undefined : LIQUIDATIONS[i];
    if (r) window.open(bscscanTx(r.tx), "_blank", "noopener");
  };

  let content = null;
  if (box) {
    const { W, H, now } = box;
    const mob = W < 760;
    const rnd = lcg(11);
    const field = Array.from({ length: 120 }, () => ({ cx: r2(rnd() * W), cy: r2(rnd() * H * 0.6), r: r2(rnd() * 0.9 + 0.2), o: r2(rnd() * 0.3 + 0.05) }));
    const R = mob ? W * 0.98 : Math.min(W * 0.4, H * 0.7);
    const cx = W / 2;
    const cy = H * 0.62 + R;
    content = (
      <>
        {field.map((s, i) => (
          <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={SKY.star} opacity={s.o} />
        ))}
        <Wheel
          id="dome"
          cx={cx}
          cy={cy}
          R={R}
          rotation={rotationFor(hourOfWeek(now))}
          sectors={weekSectors(now).sectors}
          liquidations={LIQUIDATIONS}
          compact={mob}
        />
        <line x1={r2(cx)} x2={r2(cx)} y1={r2(cy - R - 30)} y2={r2(cy - R * 0.16)} stroke={SKY.mint} strokeWidth={1.5} />
        <path d={`M${r2(cx - 6)} ${r2(cy - R - 30)}h12l-6 10z`} fill={SKY.mint} />
      </>
    );
  }

  return (
    <>
      <svg
        ref={svgRef}
        className={className}
        viewBox={box ? `0 0 ${box.W} ${box.H}` : undefined}
        aria-hidden="true"
        onClick={onClick}
        {...handlers}
      >
        {content}
      </svg>
      <StarTip tip={tip} />
    </>
  );
}
