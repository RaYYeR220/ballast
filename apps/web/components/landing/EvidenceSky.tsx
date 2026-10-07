"use client";
/* Evidence: the full wheel of 121 liquidations with the weekend at the bottom and four callouts.
   Stars are links to BscScan; Tab enters the sky once, arrow keys walk the stars in time order. */
import { useLayoutEffect, useRef, useState } from "react";
import { StarTip, useStarRoving, useStarTip } from "@/components/planisphere/StarTip";
import { Wheel } from "@/components/planisphere/Wheel";
import { angleOf, polar, r2, radiusForUsd } from "@/lib/planisphere/geometry";
import { typicalWeekSectors } from "@/lib/planisphere/sessions";
import { FACTS, kUsd, LIQUIDATIONS, pct } from "@/lib/liquidations";

const CX = 380;
const CY = 360;
const R = 282;
const ROT = 180 - angleOf(140); // Saturday 20:00 at the bottom
const SECTORS = typicalWeekSectors();

const toScreen = (deg: number, r: number): [number, number] => {
  const [x, y] = polar(deg + ROT, r);
  return [CX + x, CY + y];
};

const bigMonday = FACTS.mondayOpen.reduce((a, b) => (a.usd > b.usd ? a : b));
const seedBins = new Array<number>(28).fill(0);
for (const r of LIQUIDATIONS) if (r.g === "seed") seedBins[Math.floor(r.h / 6)]!++;
const busiestSeedBin = seedBins.indexOf(Math.max(...seedBins));

interface CalloutSpec {
  deg: number;
  r: number;
  lx: number;
  /** baseline of the first line as a function of the font scale */
  ly: (k: number) => number;
  anchor: "start" | "end";
  lines: string[];
}

const CALLOUTS: CalloutSpec[] = [
  {
    deg: angleOf(140),
    r: R * 0.42,
    lx: 4,
    ly: (k) => 708 - 2 * 22 * k,
    anchor: "start",
    lines: ["The weekend sky is empty", "Friday 8 PM to Sunday 8 PM:", "29% of the clock, no liquidations"],
  },
  {
    deg: angleOf(bigMonday.h),
    r: radiusForUsd(bigMonday.usd, R),
    lx: 4,
    ly: (k) => 24 * k,
    anchor: "start",
    lines: ["Monday, 9:30 to 11:00", `${FACTS.mondayOpen.length} liquidations, ${kUsd(FACTS.mondayUsd)}`, `${pct(FACTS.mondayShare)} of real borrowers' losses`],
  },
  {
    deg: angleOf(busiestSeedBin * 6 + 3),
    r: radiusForUsd(11, R),
    lx: 756,
    ly: (k) => 708 - 2 * 22 * k,
    anchor: "end",
    lines: [
      "Hollow rings: one test address",
      `${FACTS.seeds} positions of $${Math.round(FACTS.seedMinUsd)} to $${Math.round(FACTS.seedMaxUsd)},`,
      "a sensor, not real losses",
    ],
  },
  {
    deg: angleOf(3 * 24 + 10.25),
    r: R * 0.83,
    lx: 756,
    ly: (k) => 24 * k,
    anchor: "end",
    lines: ["Dashed wedges", "the first 90 minutes after each open"],
  },
];

/* rough advance widths until the real fonts can be measured */
const estimate = (lines: string[], k: number) =>
  Math.max(...lines.map((s, i) => s.length * (i ? 13 * 0.5 : 19 * 0.42) * k));

function Callout({ spec, k }: { spec: CalloutSpec; k: number }) {
  const refs = useRef<(SVGTextElement | null)[]>([]);
  const [w, setW] = useState(() => estimate(spec.lines, k));
  useLayoutEffect(() => {
    let live = true;
    const measure = () => {
      if (!live) return;
      const ws = refs.current.map((t) => t?.getComputedTextLength() ?? 0);
      if (ws.some((x) => x > 0)) setW(Math.max(...ws));
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
    };
  }, [k]);
  const [x, y] = toScreen(spec.deg, spec.r);
  const ly = spec.ly(k);
  const edge = spec.anchor === "start" ? spec.lx + w + 8 : spec.lx - w - 8;
  const ty = ly - 6 * k;
  return (
    <g aria-hidden="true">
      {spec.lines.map((s, i) => (
        <text
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={i ? "f-ui" : "f-display"}
          x={spec.lx}
          y={r2(ly + i * 16 * k + (i ? 6 * k : 0))}
          textAnchor={spec.anchor}
          fontSize={r2((i ? 13 : 19) * k)}
          fontStyle={i ? "normal" : "italic"}
          fill={i ? "#8fa3c9" : "#f3ecd9"}
        >
          {s}
        </text>
      ))}
      <polyline points={`${r2(x)},${r2(y)} ${r2(x)},${r2(ty)} ${r2(edge)},${r2(ty)}`} fill="none" stroke="#d8ccab" strokeWidth={1} opacity={0.75} />
      <circle cx={r2(x)} cy={r2(y)} r={3.2} fill="#f3ecd9" />
    </g>
  );
}

export function EvidenceSky({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [k, setK] = useState(1);
  const { tip, handlers } = useStarTip(LIQUIDATIONS);
  const { active, onKeyDown } = useStarRoving(LIQUIDATIONS);

  // the drawing scales with the column; text grows back to a readable size on narrow screens
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const w = svg.getBoundingClientRect().width;
      setK(Math.min(1.9, Math.max(1, (760 / Math.max(1, w)) * 0.75)));
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

  return (
    <>
      <svg
        ref={svgRef}
        className={className}
        viewBox="0 0 760 720"
        role="group"
        aria-label="The full star wheel of 121 Lista liquidations with the weekend at the bottom. The weekend sector is empty. The brightest stars sit just after Monday's open. Each star links to its transaction; use the arrow keys to move between stars in time order."
        onKeyDown={onKeyDown}
        {...handlers}
      >
        <Wheel
          id="ev"
          cx={CX}
          cy={CY}
          R={R}
          rotation={ROT}
          sectors={SECTORS}
          liquidations={LIQUIDATIONS}
          fontScale={Math.min(1.4, k)}
          links
          activeStar={active}
        />
        {CALLOUTS.map((c, i) => (
          <Callout key={i} spec={c} k={k} />
        ))}
      </svg>
      <StarTip tip={tip} />
    </>
  );
}
