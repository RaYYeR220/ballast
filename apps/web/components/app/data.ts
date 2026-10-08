"use client";
/* Client reads through the app's own routes (the RPC URL and the desk address stay on the server). */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { DeskEvent, DeskHealth, DeskResult } from "@/lib/desk";
import type { AccountsBody, LoansBody, MarketsBody, TokenView } from "@/lib/views";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as T | { error?: string } | null;
  if (!res.ok || body === null) {
    const msg = body && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const keys = {
  accounts: (owner: string) => ["accounts", owner.toLowerCase()] as const,
  loans: (user: string) => ["loans", user.toLowerCase()] as const,
  token: (token: string, owner: string, spender: string | null) => ["token", token.toLowerCase(), owner.toLowerCase(), spender?.toLowerCase() ?? ""] as const,
};

export function useDeskHealth() {
  return useQuery({
    queryKey: ["desk", "health"],
    queryFn: () => getJson<DeskResult<DeskHealth>>("/api/desk/health"),
    refetchInterval: 30_000,
  });
}

export function useDeskFeed(account: string | null, limit = 100) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (account) qs.set("account", account);
  return useQuery({
    queryKey: ["desk", "feed", account?.toLowerCase() ?? "all", limit],
    queryFn: () => getJson<DeskResult<{ events: DeskEvent[] }>>(`/api/desk/feed?${qs}`),
    refetchInterval: 15_000,
  });
}

export function useAccounts(owner: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.accounts(owner ?? ""),
    queryFn: () => getJson<AccountsBody>(`/api/accounts?owner=${owner}`),
    enabled: enabled && !!owner,
    refetchInterval: 30_000,
  });
}

export function useLoans(user: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.loans(user ?? ""),
    queryFn: () => getJson<LoansBody & { defi?: { status: string; protocols: { id: string; valueUsd: string }[] } }>(`/api/loans?user=${user}`),
    enabled: enabled && !!user,
    staleTime: 60_000,
  });
}

export function useMarkets(enabled = true) {
  return useQuery({ queryKey: ["markets"], queryFn: () => getJson<MarketsBody>("/api/markets"), enabled, staleTime: 5 * 60_000 });
}

export async function fetchToken(token: string, owner: string, spender: string | null): Promise<TokenView> {
  const qs = new URLSearchParams({ token, owner });
  if (spender) qs.set("spender", spender);
  const r = await getJson<({ status: "ok" } & TokenView) | { status: "unavailable"; detail: string }>(`/api/token?${qs}`);
  if (r.status !== "ok") throw new Error(r.detail);
  return r;
}

export function useToken(token: string | null, owner: string | undefined, spender: string | null) {
  return useQuery({
    queryKey: keys.token(token ?? "", owner ?? "", spender),
    queryFn: () => fetchToken(token!, owner!, spender),
    enabled: !!token && !!owner,
    staleTime: 15_000,
  });
}

/** Unix seconds, re-read on each minute boundary; null until mounted (keeps server and client HTML equal). */
export function useMinuteClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
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
