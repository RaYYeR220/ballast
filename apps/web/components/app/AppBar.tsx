"use client";
/* The app bar: mark, sections, the desk's state and the wallet. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import type { DeskHealth, DeskResult } from "@/lib/desk";
import { shortHex } from "@/lib/format";
import s from "./app.module.css";

/* `ready: false` marks a section whose page is not built yet: it is named in the bar but is not a link. */
export const SECTIONS = [
  { href: "/app", label: "Dashboard", ready: true },
  { href: "/oracle", label: "Session Oracle", ready: true },
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
    dot = s.dotOn;
    text = health.data.dryRun ? "Desk on, dry run" : "Desk on";
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

export function WalletControl({ align = "right", look = "pill" }: { align?: "left" | "right"; look?: "pill" | "button" }) {
  const { address, isConnected, connector } = useAccount();
  const connectors = useConnectors();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // wallets that announced themselves (EIP-6963) by name; the generic injected one only when none did and the
  // page does have a provider (read on open, so the server and the first client render agree)
  const named = connectors.filter((c) => c.id !== "injected");
  const hasProvider = open && typeof window !== "undefined" && "ethereum" in window;
  const list = named.length > 0 ? named : hasProvider ? connectors : [];

  if (isConnected && address) {
    return (
      <div ref={box} style={{ position: "relative" }}>
        <button type="button" className={s.pill} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
          {shortHex(address)}
        </button>
        {open ? (
          <div className={s.menu} role="menu" style={align === "left" ? { left: 0, right: "auto" } : undefined}>
            <p>Connected with {connector?.name ?? "a browser wallet"}</p>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div ref={box} style={{ position: "relative" }}>
      <button type="button" className={look === "button" ? s.btn : s.pill} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} disabled={isPending}>
        {isPending ? "Connecting..." : "Connect wallet"}
      </button>
      {open ? (
        <div className={s.menu} role="menu" aria-label="Choose a wallet" style={align === "left" ? { left: 0, right: "auto" } : undefined}>
          {list.length === 0 ? (
            <p>No browser wallet found. Install Binance Web3 Wallet, MetaMask or Rabby, then reload this page.</p>
          ) : (
            list.map((c) => (
              <button
                key={c.uid}
                type="button"
                role="menuitem"
                onClick={() => {
                  connect({ connector: c });
                  setOpen(false);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.icon ? <img src={c.icon} alt="" /> : null}
                {c.id === "injected" ? "Browser wallet" : c.name}
              </button>
            ))
          )}
          {error ? <p>{error.message.split("\n")[0]}</p> : null}
        </div>
      ) : null}
    </div>
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
