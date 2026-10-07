/* The star wheel itself: disc, daylight, first-90-minute wedges, money graticule, session ring, rim, stars.
   Pure SVG with no hooks, so it renders on the server for static skies and inside <Planisphere> for the dial. */
import type { ReactNode } from "react";
import {
  angleOf,
  DAYS,
  polar,
  r2,
  radiusForUsd,
  sectorPath,
  starSize,
  WEEK_HOURS,
} from "@/lib/planisphere/geometry";
import { regularSectors } from "@/lib/planisphere/sessions";
import type { Liquidation, Sector, SectorKind } from "@/lib/planisphere/types";

/* colours are the design tokens; SVG presentation attributes cannot read CSS variables */
export const SKY = {
  star: "#fff6d8",
  cream: "#f3ecd9",
  cream3: "#d8ccab",
  p200: "#bac7df",
  p300: "#8fa3c9",
  p500: "#3d5a94",
  p800: "#12244a",
  p900: "#0b1733",
  p950: "#070f22",
  mint: "#3ef0b5",
  ember: "#ff9f80",
} as const;

/* the one-hue session ramp (validated for contrast on the night disc); the weekend is left dark */
const RING: Partial<Record<SectorKind, readonly [string, number]>> = {
  regular: ["#e6ecf7", 1],
  pre: ["#b5c4e2", 0.75],
  post: ["#b5c4e2", 0.75],
  overnight: ["#8399c8", 0.55],
  holiday: ["#5f78b2", 0.5],
};

const SESSION_NAME: Record<Liquidation["s"], string> = {
  regular: "regular session",
  pre: "pre-market",
  post: "after hours",
  overnight: "overnight",
  holiday: "holiday",
  weekend: "weekend",
};
const GROUP_NAME: Record<Liquidation["g"], string> = {
  organic: "organic borrower",
  seed: "tripwire test address",
  loan: "bStock was the loan asset",
};

export const bscscanTx = (tx: string) => `https://bscscan.com/tx/${tx}`;

export const starLabel = (r: Liquidation) =>
  `${r.et}, ${r.holiday ? `holiday (${r.holiday})` : SESSION_NAME[r.s]}, ${r.c}, $${r.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} repaid, ${GROUP_NAME[r.g]}`;

export interface WheelSkyProps {
  /** unique prefix for gradient and filter ids */
  id: string;
  R: number;
  sectors: readonly Sector[];
  liquidations: readonly Liquidation[];
  compact?: boolean;
  fontScale?: number;
  rimLabels?: boolean;
  money?: boolean;
  wedges?: boolean;
  discFill?: string;
  /** dim the stars when they are context, not the subject */
  starOpacity?: number;
  /** render stars as links to BscScan carrying data-star = index into `liquidations` */
  links?: boolean;
  /** index of the one star in the tab order (roving focus); others are reachable with arrow keys */
  activeStar?: number | null;
  /** a closure window to mark on the wheel, in hours of the week */
  window?: { h0: number; h1: number } | null;
  /** wheel-space marks drawn on top; they rotate with the sky */
  children?: ReactNode;
}

export function WheelSky({
  id,
  R,
  sectors,
  liquidations,
  compact = false,
  fontScale: fs = 1,
  rimLabels = true,
  money = true,
  wedges = true,
  discFill,
  starOpacity,
  links = false,
  activeStar = null,
  window: win = null,
  children,
}: WheelSkyProps) {
  const daylight = regularSectors(sectors);
  const maxUsd = liquidations.reduce((m, r) => Math.max(m, r.usd), 0);
  const order = liquidations.map((r, i) => i).sort((a, b) => liquidations[a]!.usd - liquidations[b]!.usd);

  return (
    <>
      <circle r={R} fill={discFill ?? `url(#${id}d)`} stroke={SKY.cream3} strokeWidth={1.2} />
      {daylight.map((s) => (
        <path key={`day${s.h0}`} d={sectorPath(s.h0, s.h1, R * 0.16, R * 0.84)} fill={SKY.cream} opacity={0.045} />
      ))}
      {wedges &&
        daylight.map((s) => (
          <path
            key={`w${s.h0}`}
            d={sectorPath(s.h0, Math.min(s.h0 + 1.5, s.h1), R * 0.16, R * 0.84)}
            fill="none"
            stroke={SKY.cream}
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.55}
          />
        ))}
      {money &&
        [10, 100, 1000, 10000].map((u) => (
          <circle key={u} r={r2(radiusForUsd(u, R))} fill="none" stroke={SKY.p500} strokeWidth={0.7} opacity={0.5} />
        ))}
      {DAYS.map((_, d) => {
        const [x, y] = polar(angleOf(d * 24), R);
        return <line key={d} x1={0} y1={0} x2={r2(x)} y2={r2(y)} stroke={SKY.p500} strokeWidth={0.7} opacity={0.35} />;
      })}
      {sectors.map((s) => {
        const style = RING[s.kind];
        return style ? (
          <path key={`r${s.h0}`} d={sectorPath(s.h0, s.h1, R * 0.855, R * 0.878)} fill={style[0]} opacity={style[1]} />
        ) : null;
      })}
      {win && win.h1 > win.h0 && (
        <path d={sectorPath(win.h0, win.h1, R * 0.835, R * 0.85)} fill={SKY.ember} opacity={0.85} />
      )}
      <g>
        {Array.from({ length: WEEK_HOURS }, (_, h) => {
          const r0 = R * (h % 24 ? (h % 6 ? 0.975 : 0.955) : 0.9);
          const [x1, y1] = polar(angleOf(h), r0);
          const [x2, y2] = polar(angleOf(h), R * 0.995);
          return (
            <line
              key={h}
              x1={r2(x1)}
              y1={r2(y1)}
              x2={r2(x2)}
              y2={r2(y2)}
              stroke={SKY.cream3}
              strokeWidth={h % 24 ? 0.6 : 1.4}
              opacity={h % 6 ? 0.45 : 0.9}
            />
          );
        })}
      </g>
      {rimLabels &&
        DAYS.map((name, d) => {
          const mid = angleOf(d * 24 + 12);
          const [x, y] = polar(mid, R * 0.928);
          return (
            <text
              key={name}
              className="f-ui"
              x={r2(x)}
              y={r2(y)}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={(compact ? 9 : 12.5) * fs}
              letterSpacing={compact ? 1.5 : 3}
              fill={SKY.cream}
              transform={`rotate(${r2(mid)} ${r2(x)} ${r2(y)})`}
              aria-hidden="true"
            >
              {(compact ? name.slice(0, 3) : name).toUpperCase()}
            </text>
          );
        })}
      <g opacity={starOpacity}>
        {order.map((i) => {
          const r = liquidations[i]!;
          const [px, py] = polar(angleOf(r.h), radiusForUsd(Math.max(3, r.usd), R));
          const x = r2(px);
          const y = r2(py);
          let marks: ReactNode;
          if (r.g === "organic") {
            const s = starSize(r.usd, maxUsd, compact, fs);
            marks = (
              <>
                {s > 4 && <circle cx={x} cy={y} r={r2(s * 2)} fill={SKY.star} opacity={0.28} filter={`url(#${id}g)`} />}
                <circle cx={x} cy={y} r={r2(s * 0.6)} fill={SKY.star} />
                {s > 6 && (
                  <>
                    <line x1={r2(x - s * 1.5)} x2={r2(x + s * 1.5)} y1={y} y2={y} stroke={SKY.star} strokeWidth={0.7} opacity={0.7} />
                    <line x1={x} x2={x} y1={r2(y - s * 1.5)} y2={r2(y + s * 1.5)} stroke={SKY.star} strokeWidth={0.7} opacity={0.7} />
                  </>
                )}
              </>
            );
          } else if (r.g === "seed") {
            marks = <circle cx={x} cy={y} r={compact ? 1.6 : 2.3} fill="none" stroke={SKY.p300} strokeWidth={1} opacity={0.75} />;
          } else {
            marks = <circle cx={x} cy={y} r={compact ? 2.2 : 3} fill="none" stroke={SKY.cream} strokeWidth={1.2} />;
          }
          const hit = <circle className="star-hit" cx={x} cy={y} r={9} fill="transparent" />;
          return links ? (
            <a
              key={i}
              href={bscscanTx(r.tx)}
              target="_blank"
              rel="noopener noreferrer"
              data-star={i}
              data-group={r.g}
              tabIndex={activeStar === i ? 0 : -1}
              aria-label={starLabel(r)}
            >
              {marks}
              {hit}
            </a>
          ) : (
            <g key={i} data-star={i} data-group={r.g}>
              {marks}
              {hit}
            </g>
          );
        })}
      </g>
      {children}
    </>
  );
}

export interface WheelProps extends WheelSkyProps {
  cx: number;
  cy: number;
  /** degrees; rotationFor(h) puts hour h under the meridian */
  rotation: number;
}

/** Gradient and blur filter the sky refers to. */
export function WheelDefs({ id, compact = false }: { id: string; compact?: boolean }) {
  return (
    <defs>
      <radialGradient id={`${id}d`}>
        <stop offset="0" stopColor={SKY.p800} />
        <stop offset=".86" stopColor={SKY.p900} />
        <stop offset="1" stopColor={SKY.p950} />
      </radialGradient>
      <filter id={`${id}g`} x="-150%" y="-150%" width="400%" height="400%">
        <feGaussianBlur stdDeviation={compact ? 2 : 3.2} />
      </filter>
    </defs>
  );
}

/** A complete, static wheel at a fixed rotation (server-renderable). */
export function Wheel({ cx, cy, rotation, ...sky }: WheelProps) {
  return (
    <>
      <WheelDefs id={sky.id} compact={sky.compact} />
      <g transform={`translate(${r2(cx)},${r2(cy)})`}>
        <circle r={sky.R + (sky.compact ? 8 : 14)} fill="none" stroke={SKY.p500} strokeWidth={1} opacity={0.6} />
        <g transform={`rotate(${r2(rotation)})`}>
          <WheelSky {...sky} />
        </g>
      </g>
    </>
  );
}
