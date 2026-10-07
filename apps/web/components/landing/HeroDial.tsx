"use client";
/* Hero star finder: the planisphere card, turned to New York's clock. Data is imported here, on the client,
   so the 121 rows ship once in the JS bundle rather than once per wheel in the RSC payload. */
import { Planisphere } from "@/components/planisphere/Planisphere";
import { FACTS, LIQUIDATIONS } from "@/lib/liquidations";

interface HeroDialProps {
  className?: string;
  svgClassName?: string;
  readoutClassName?: string;
  hintClassName?: string;
}

export function HeroDial({ className, svgClassName, readoutClassName, hintClassName }: HeroDialProps) {
  return (
    <Planisphere
      liquidations={LIQUIDATIONS}
      frame="card"
      caption="Lista bStock liquidations, 18 June to 22 September 2026, New York time"
      label={`Star finder: the New York trading week as a wheel seen through a round window. Stars are ${FACTS.total} real bStock liquidations on Lista; the weekend sector has none. Use the arrow keys to turn the wheel by an hour, Page Up and Page Down by a day.`}
      className={className}
      svgClassName={svgClassName}
      readoutClassName={readoutClassName}
      hintClassName={hintClassName}
    />
  );
}
