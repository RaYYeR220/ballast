"use client";
/* The wallet button and its menu. Disconnected: the wallets this browser announced (EIP-6963), a pending
   state while the wallet asks for approval, and the reason when connecting fails. Connected: the address, a
   warning and a switch when the wallet is on another network, copy and disconnect. The menu is a real menu:
   arrow keys move, Escape closes and hands focus back to the button. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAccount, useConfig, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { shortHex } from "@/lib/format";
import s from "./app.module.css";

function connectMessage(err: Error): string {
  const e = err as Error & { shortMessage?: string; cause?: { name?: string } };
  if (e.name === "UserRejectedRequestError" || e.cause?.name === "UserRejectedRequestError" || /user (rejected|denied)/i.test(e.message)) {
    return "You declined the connection in your wallet.";
  }
  if (e.name === "ProviderNotFoundError") return "That wallet is not available in this browser.";
  if (/already pending/i.test(e.message)) return "Your wallet already has a request open. Finish it there first.";
  return (e.shortMessage ?? e.message).split("\n")[0] ?? "The wallet did not connect.";
}

export function WalletControl({ align = "right", look = "pill" }: { align?: "left" | "right"; look?: "pill" | "button" }) {
  const { address, isConnected, connector, chainId } = useAccount();
  const config = useConfig();
  const target = config.chains[0];
  const connectors = useConnectors();
  const { connect, isPending, error, variables, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setCopied(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", outside);
    // the first choice takes focus, so the keyboard lands inside the menu
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("mousedown", outside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  // wallets that announced themselves (EIP-6963) by name; the generic injected one only when none did and the
  // page does have a provider (read on open, so the server and the first client render agree)
  const named = connectors.filter((c) => c.id !== "injected");
  const hasProvider = open && typeof window !== "undefined" && "ethereum" in window;
  const list = named.length > 0 ? named : hasProvider ? connectors : [];
  const menuStyle = align === "left" ? { left: 0, right: "auto" } : undefined;

  if (isConnected && address) {
    const wrong = !!target && chainId !== target.id;
    return (
      <div ref={box} style={{ position: "relative" }} onKeyDown={onKeyDown}>
        <button ref={trigger} type="button" className={s.pill} aria-expanded={open} aria-haspopup="menu" onClick={() => (open ? close(false) : setOpen(true))}>
          {wrong ? <i className={`${s.dot} ${s.dotOff}`} aria-hidden="true" /> : null}
          {wrong ? "Wrong network" : shortHex(address)}
        </button>
        {open ? (
          <div ref={menu} className={s.menu} role="menu" aria-label="Wallet" style={menuStyle}>
            <p>
              {shortHex(address, 6, 6)}, connected with {connector?.name ?? "a browser wallet"}
            </p>
            {wrong && target ? (
              <>
                <p>Your wallet is on another network. Ballast runs on {target.name}.</p>
                <button type="button" role="menuitem" disabled={switching} onClick={() => switchChain({ chainId: target.id }, { onSuccess: () => close(true) })}>
                  {switching ? "Confirm the switch in your wallet..." : `Switch to ${target.name}`}
                </button>
                {switchError ? <p role="alert">{connectMessage(switchError)}</p> : null}
              </>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void navigator.clipboard?.writeText(address).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Address copied" : "Copy address"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                disconnect();
                close(true);
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const pendingName = isPending ? connectors.find((c) => c.uid === (variables?.connector as { uid?: string } | undefined)?.uid)?.name : undefined;
  return (
    <div ref={box} style={{ position: "relative" }} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={look === "button" ? s.btn : s.pill}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          if (open) return close(false);
          reset();
          setOpen(true);
        }}
      >
        {isPending ? "Connecting..." : "Connect wallet"}
      </button>
      {open ? (
        <div ref={menu} className={s.menu} role="menu" aria-label="Choose a wallet" style={menuStyle}>
          {list.length === 0 ? (
            <p>No browser wallet found. Install Binance Web3 Wallet, MetaMask or Rabby, then reload this page.</p>
          ) : (
            list.map((c) => (
              <button
                key={c.uid}
                type="button"
                role="menuitem"
                disabled={isPending}
                // the menu stays open until the wallet answers, so a refusal or a failure can be read here
                onClick={() => connect({ connector: c }, { onSuccess: () => close(false) })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.icon ? <img src={c.icon} alt="" /> : null}
                {c.id === "injected" ? "Browser wallet" : c.name}
              </button>
            ))
          )}
          {isPending ? <p role="status">Approve the connection in {pendingName && pendingName !== "Injected" ? pendingName : "your wallet"}.</p> : null}
          {error && !isPending ? <p role="alert">{connectMessage(error)}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
