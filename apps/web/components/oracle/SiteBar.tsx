"use client";
/* The bar and section tabs shared by the Session Oracle, guardian, evidence and replay pages, plus the
   New York clock they all show. These pages need no wallet, so the bar carries none. */
import { session } from "@ballast/risk";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { hourLabel } from "@/lib/planisphere/geometry";
import { hourOfWeek } from "@/lib/planisphere/sessions";
import s from "@/components/app/app.module.css";

export const SITE_SECTIONS = [
  { href: "/app", label: "Dashboard" },
  { href: "/oracle", label: "Session Oracle" },
  { href: "/evidence", label: "Evidence" },
  { href: "/judge", label: "Replay" },
] as const;

export type SitePath = (typeof SITE_SECTIONS)[number]["href"];

function Sections({ current }: { current: SitePath }) {
  return (
    <>
      {SITE_SECTIONS.map((x) => (
        <Link key={x.href} href={x.href} aria-current={x.href === current ? "page" : undefined}>
          {x.label}
        </Link>
      ))}
    </>
  );
}

export function SiteBar({ current, right }: { current: SitePath; right?: ReactNode }) {
  return (
    <header className={s.bar}>
      <Link href="/" className={s.mark}>
        Ballast
      </Link>
      <nav aria-label="Sections">
        <Sections current={current} />
      </nav>
      {right ? <div className={s.right}>{right}</div> : null}
    </header>
  );
}

export function SiteTabs({ current }: { current: SitePath }) {
  return (
    <nav className={s.tabsM} aria-label="Sections">
      <Sections current={current} />
    </nav>
  );
}

/** Unix seconds, re-read on each minute boundary. Starts from the server's time so the first render matches. */
export function useNow(initial: number): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const ms = Date.now();
      setNow(Math.floor(ms / 1000));
      t = setTimeout(tick, 60_000 - (ms % 60_000) + 20);
    };
    tick();
    return () => clearTimeout(t);
  }, []);
  return now;
}

export const clockText = (now: number) => `${hourLabel(hourOfWeek(now))} New York, ${session(now) === "REGULAR" ? "market open" : "market closed"}`;

/** "Thursday 18:02 New York, market closed" */
export function ClockTag({ now }: { now: number }) {
  return (
    <span className={`${s.tag} ${s.live}`} suppressHydrationWarning>
      {clockText(now)}
    </span>
  );
}

/** A status pill for the bar: a dot and a short sentence. */
export function StatusPill({ tone, children, title }: { tone: "on" | "off" | "idle"; children: ReactNode; title?: string }) {
  return (
    <span className={s.pill} role="status" title={title}>
      <i className={`${s.dot} ${tone === "on" ? s.dotOn : tone === "off" ? s.dotOff : s.dotIdle}`} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/** Fetches JSON from one of the app's own routes, keeps the last good answer while it refreshes. */
export function useJson<T>(url: string | null, initial: T | null, refreshMs: number): { data: T | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ url: string | null; data: T | null; loading: boolean; error: string | null }>({ url, data: initial, loading: initial === null && url !== null, error: null });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        const body = (await res.json().catch(() => null)) as T | null;
        if (!live) return;
        if (!res.ok || body === null) {
          const said = (body as { error?: unknown } | null)?.error;
          const msg = typeof said === "string" ? said : `HTTP ${res.status}`;
          setState((p) => ({ ...p, url, loading: false, error: msg }));
        } else setState({ url, data: body, loading: false, error: null });
      } catch (err) {
        if (live) setState((p) => ({ ...p, url, loading: false, error: (err as Error).message }));
      }
      if (live) timer = setTimeout(load, refreshMs);
    };
    // the server already sent the first answer for the first address; anything else is fetched now
    const fresh = state.url === url && state.data !== null;
    if (fresh) timer = setTimeout(load, refreshMs);
    else {
      setState((p) => ({ ...p, loading: true }));
      void load();
    }
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, refreshMs]);
  // an answer for another address is kept on screen (dimmed by `loading`) until the new one arrives
  return { data: state.data, loading: state.loading || state.url !== url, error: state.error };
}
