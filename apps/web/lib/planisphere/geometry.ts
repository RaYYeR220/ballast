/* Planisphere geometry: the New York trading week drawn as a wheel.
   Angle = hour of the week (Monday 00:00 at the top before rotation, clockwise).
   Radius = repaid USD on a log scale ($3 at 0.2 R, $12k at 0.8 R). Pure functions only. */

export const WEEK_HOURS = 168;
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export const USD_INNER = 3;
export const USD_OUTER = 12_000;
export const R_INNER = 0.2;
export const R_OUTER = 0.8;

const mod = (x: number, m: number) => ((x % m) + m) % m;
/** round for SVG output; two decimals is well below a device pixel */
export const r2 = (x: number) => Math.round(x * 100) / 100;

export const wrapHour = (h: number) => mod(h, WEEK_HOURS);

/** degrees clockwise from the top for an hour of the week */
export const angleOf = (h: number) => (h / WEEK_HOURS) * 360;

/** wheel-space point for an angle (deg, clockwise from the top) and radius */
export function polar(deg: number, r: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** rotation that brings hour h under the meridian at the top */
export const rotationFor = (h: number) => -angleOf(h);

/** the hour of the week sitting under the meridian for a wheel rotation */
export const hourAtTop = (rotation: number) => wrapHour((-rotation / 360) * WEEK_HOURS);

/** annular sector between hours h0..h1 and radii r0..r1 */
export function sectorPath(h0: number, h1: number, r0: number, r1: number): string {
  const [ax, ay] = polar(angleOf(h0), r1);
  const [bx, by] = polar(angleOf(h1), r1);
  const [cx, cy] = polar(angleOf(h1), r0);
  const [dx, dy] = polar(angleOf(h0), r0);
  const large = angleOf(h1) - angleOf(h0) > 180 ? 1 : 0;
  return (
    `M${r2(ax)} ${r2(ay)}A${r2(r1)} ${r2(r1)} 0 ${large} 1 ${r2(bx)} ${r2(by)}` +
    `L${r2(cx)} ${r2(cy)}A${r2(r0)} ${r2(r0)} 0 ${large} 0 ${r2(dx)} ${r2(dy)}Z`
  );
}

/** distance from the centre for a repaid amount, log scale, clamped to [0.2 R, 0.8 R] */
export function radiusForUsd(usd: number, R: number): number {
  const lo = Math.log10(USD_INNER);
  const hi = Math.log10(USD_OUTER);
  const k = usd > 0 ? (Math.log10(usd) - lo) / (hi - lo) : 0;
  return R * (R_INNER + (R_OUTER - R_INNER) * Math.max(0, Math.min(1, k)));
}

/** size of an organic star: grows with the square root of its share of the largest liquidation */
export function starSize(usd: number, maxUsd: number, compact = false, fontScale = 1): number {
  const share = maxUsd > 0 ? Math.sqrt(Math.max(0, usd) / maxUsd) : 0;
  return (compact ? 1.4 : 2) + share * (compact ? 6 : 10) * fontScale;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "Tuesday 07:35" for an hour of the week */
export function hourLabel(h: number): string {
  const w = wrapHour(h);
  const day = Math.floor(w / 24);
  const t = w % 24;
  const totalMin = Math.floor(t * 60 + 1e-6);
  return `${DAYS[day]} ${pad2(Math.floor(totalMin / 60))}:${pad2(totalMin % 60)}`;
}

/** signed shortest turn from angle a to angle b, in degrees */
export const shortestTurn = (a: number, b: number) => mod(b - a + 180, 360) - 180;
