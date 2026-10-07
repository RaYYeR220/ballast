/* The small wheel on the refusal slip: the sky at the attempted restore (Saturday 14:02), meridian in ember. */
import { Wheel } from "@/components/planisphere/Wheel";
import { rotationFor } from "@/lib/planisphere/geometry";
import { typicalWeekSectors } from "@/lib/planisphere/sessions";
import { LIQUIDATIONS } from "@/lib/liquidations";

const ATTEMPT_H = 5 * 24 + 14 + 2 / 60;

export function MiniSky({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 150 150" aria-hidden="true">
      <Wheel
        id="mini"
        cx={75}
        cy={75}
        R={62}
        rotation={rotationFor(ATTEMPT_H)}
        sectors={typicalWeekSectors()}
        liquidations={LIQUIDATIONS}
        compact
        rimLabels={false}
        money={false}
        wedges={false}
      />
      <line x1={75} x2={75} y1={2} y2={62} stroke="#ff9f80" strokeWidth={1.5} />
      <circle cx={75} cy={16} r={5} fill="none" stroke="#ff9f80" strokeWidth={2} />
      <line x1={70} y1={11} x2={80} y2={21} stroke="#ff9f80" strokeWidth={2} />
    </svg>
  );
}
