"use client";
/* The wheel: the user's week in New York time. Mint ticks are shields, cream rings restores, ember crosses
   refusals (from the desk feed, planned ones fainter); faint stars are the real Lista liquidations for context. */
import { nextClose } from "@ballast/risk";
import { memo, useCallback } from "react";
import { Planisphere, type DialGeometry } from "@/components/planisphere/Planisphere";
import { SKY } from "@/components/planisphere/Wheel";
import type { LogRow } from "@/lib/feed-rows";
import { countdown, nyWeekdayClock } from "@/lib/format";
import { angleOf, polar, r2 } from "@/lib/planisphere/geometry";
import { hourOfWeek } from "@/lib/planisphere/sessions";
import { LIQUIDATIONS } from "@/lib/liquidations";
import s from "./app.module.css";

const WEEK_SEC = 7 * 86_400;

const Marks = memo(function Marks({ rows, R, now }: { rows: readonly LogRow[]; R: number; now: number }) {
  const r = R * 0.72;
  return (
    <g aria-hidden="true">
      {rows.map((row) => {
        if (row.ts < now - WEEK_SEC || row.ts > now + WEEK_SEC) return null;
        const a = angleOf(hourOfWeek(row.ts));
        const [x0, y0] = polar(a, r);
        const x = r2(x0);
        const y = r2(y0);
        const opacity = row.planned ? 0.55 : 1;
        if (row.kind === "shield") {
          return <path key={row.key} d={`M${x} ${r2(y - 6)}l6 10h-12z`} fill={SKY.mint} opacity={opacity} transform={`rotate(${r2(a)} ${x} ${y})`} />;
        }
        if (row.kind === "restore") {
          return <circle key={row.key} cx={x} cy={y} r={5} fill="none" stroke={SKY.cream} strokeWidth={2} opacity={opacity} />;
        }
        if (row.kind === "refused") {
          return <path key={row.key} d={`M${r2(x - 6)} ${r2(y - 6)}l12 12M${r2(x + 6)} ${r2(y - 6)}l-12 12`} stroke={SKY.ember} strokeWidth={2.5} opacity={opacity} />;
        }
        return null;
      })}
    </g>
  );
});

export function WeekPanel({ now, rows }: { now: number | null; rows: readonly LogRow[] }) {
  const marks = useCallback((geo: DialGeometry) => (now === null ? null : <Marks rows={rows} R={geo.R} now={now} />), [rows, now]);
  const close = now === null ? 0 : nextClose(now);
  return (
    <section className={`${s.panel} ${s.span5}`} aria-label="Your week on the wheel">
      <div className={s.ph}>
        <div>
          <h2>The wheel</h2>
          <p className={s.sub}>Now is at the top. The sky turns once a week.</p>
        </div>
      </div>
      <div className={s.wheelwrap}>
        <Planisphere
          liquidations={LIQUIDATIONS}
          label="Your week as a star wheel with shield, restore and refusal marks"
          compact
          fontScale={1.15}
          money={false}
          wedges={false}
          starOpacity={0.35}
          marks={marks}
          readoutClassName={s.hideReadout}
        />
        <div className={s.center}>
          <div>
            <small>Next close in</small>
            <b>{now === null ? "\u00a0" : close ? countdown(close - now) : "unknown"}</b>
            <small>{now !== null && close ? nyWeekdayClock(close) : "\u00a0"}</small>
          </div>
        </div>
      </div>
      <div className={s.key}>
        <span>
          <i className={s.kSh} aria-hidden="true" />
          Shield
        </span>
        <span>
          <i className={s.kRs} aria-hidden="true" />
          Restore
        </span>
        <span>
          <i className={s.kRf} aria-hidden="true" />
          Refused
        </span>
        <span>
          <i className={s.kSt} aria-hidden="true" />
          Lista liquidations
        </span>
      </div>
    </section>
  );
}
