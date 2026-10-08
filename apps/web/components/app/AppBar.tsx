"use client";
/* The app bar: mark, sections, the desk's state and the wallet. */
import Link from "next/link";
import type { DeskHealth, DeskResult } from "@/lib/desk";
import { WalletControl } from "./WalletControl";
import s from "./app.module.css";

export { WalletControl };

/* `ready: false` marks a section whose page is not built yet: it is named in the bar but is not a link. */
export const SECTIONS = [
  { href: "/app", label: "Dashboard", ready: true },
  { href: "/oracle", label: "Session Oracle", ready: false },
  { href: "/guardians", label: "Guardians", ready: false },
] as const;

function SectionLinks({ current }: { current: string }) {
  return (
    <>
      {SECTIONS.map((x) =>
        x.ready ? (
          <Link key={x.href} href={x.href} aria-current={x.href === current ? "page" : undefined}>
            {x.label}
          </Link>
        ) : (
          <span key={x.href} aria-disabled="true" title="Not open yet">
            {x.label}
          </span>
        ),
      )}
    </>
  );
}

export function DeskPill({ health }: { health: DeskResult<DeskHealth> | undefined }) {
  let dot = s.dotIdle;
  let text = "Checking the desk";
  if (health?.status === "online") {
    // a halted desk answers but signs nothing until its operator clears the cause
    const halted = health.data.ok === false;
    dot = halted ? s.dotOff : s.dotOn;
    text = halted ? "Desk halted" : health.data.dryRun ? "Desk on, dry run" : "Desk on";
  } else if (health?.status === "offline") {
    dot = s.dotOff;
    text = health.reason === "not-configured" ? "No desk connected" : "Desk offline";
  }
  return (
    <span className={s.pill} role="status" title={health?.status === "offline" ? health.detail : undefined}>
      <i className={`${s.dot} ${dot}`} aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function AppBar({ health }: { health: DeskResult<DeskHealth> | undefined }) {
  return (
    <header className={s.bar}>
      <Link href="/" className={s.mark}>
        Ballast
      </Link>
      <nav aria-label="App">
        <SectionLinks current="/app" />
      </nav>
      <div className={s.right}>
        <DeskPill health={health} />
        <WalletControl />
      </div>
    </header>
  );
}

export function MobileTabs() {
  return (
    <nav className={s.tabsM} aria-label="App sections">
      <SectionLinks current="/app" />
    </nav>
  );
}
