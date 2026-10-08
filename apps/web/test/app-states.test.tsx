// @vitest-environment jsdom
/* Empty, offline and refusal states: every panel says what is missing instead of showing something made up. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfig, http, WagmiProvider } from "wagmi";
import { AppRoot } from "../components/app/AppRoot";
import { DeskPill } from "../components/app/AppBar";
import { DeskNotes, RefusalLog, WatchLog } from "../components/app/DeskPanels";
import { comingSentence, healthStatus, HealthPanel } from "../components/app/HealthPanel";
import { gaugeScale, layoutBelow } from "../components/app/Gauge";
import { CreateAccountForm } from "../components/app/CreateAccount";
import { AmountField } from "../components/app/fields";
import { StockPicker } from "../components/app/StockPicker";
import { TxRunnerContext } from "../components/app/TxFlow";
import { deleveragePathFor, marketById } from "../lib/markets";
import type { MarketView, StocksBody } from "../lib/views";
import { DEPLOYMENT } from "./helpers";
import { errorSignature, RefusalCard } from "../components/app/RefusalCard";
import type { AppConfig } from "../lib/app-config";
import { bsc } from "../lib/chains";
import type { DeskEvent, DeskResult } from "../lib/desk";
import { plannedRows } from "../lib/feed-rows";
import { E18, KEEPER, nvda, OWNER, TUE_1100, VIEW } from "./fixtures";

const TX = `0x${"ab".repeat(32)}`;
const OFF_UNSET: DeskResult<{ events: DeskEvent[] }> = { status: "offline", reason: "not-configured", detail: "no desk agent is set up for this site" };
const OFF_DOWN: DeskResult<{ events: DeskEvent[] }> = { status: "offline", reason: "unreachable", detail: "the desk did not answer in time" };
const online = (events: DeskEvent[]): DeskResult<{ events: DeskEvent[] }> => ({ status: "online", data: { events }, fetchedAt: TUE_1100 });
const EVENTS: DeskEvent[] = [
  { seq: 4, ts: TUE_1100 - 60, kind: "noop", reason: "survives a 417 bps gap at HF 1.33" },
  { seq: 3, ts: TUE_1100 - 3600, kind: "refused", source: "keeper", plan: { step: { fn: "restore", assets: (2_400n * E18).toString() } }, error: { name: "RestoreRefused", message: "restore refused by the Session Oracle: NOT_REGULAR", reason: "NOT_REGULAR" }, note: "The restore was refused because New York was closed." },
  { seq: 2, ts: TUE_1100 - 7200, kind: "shield", source: "keeper", txHash: TX, plan: { step: { fn: "shieldRepay", assets: (2_900n * E18).toString() } } },
];
const U = { decimals: 18, symbol: "USD1" };

function Wallets({ children }: { children: ReactNode }) {
  const config = createConfig({ chains: [bsc], connectors: [], transports: { [bsc.id]: http() } });
  return (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("watch log", () => {
  it("says the desk is not connected instead of listing anything", () => {
    render(<WatchLog feed={OFF_UNSET} planned={[]} chainId={56} scope="desk" />);
    expect(screen.getByText("No desk agent is connected.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Nothing from the agent is shown until it answers");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Full history" })).toBeNull();
  });

  it("says the desk is offline when it does not answer", () => {
    render(<WatchLog feed={OFF_DOWN} planned={[]} chainId={56} scope="account" />);
    expect(screen.getByText("The desk is offline.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("The desk did not answer in time.");
  });

  it("keeps the chain-derived plan visible while the desk is offline", () => {
    render(<WatchLog feed={OFF_DOWN} planned={plannedRows(VIEW, TUE_1100, [])} units={U} chainId={56} scope="account" />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Shield for tonight, repay about 2,900 USD1 to reach 41.0%");
    expect(rows[0]!.textContent).toContain("planned");
  });

  it("has an empty state for an account the desk has not touched", () => {
    render(<WatchLog feed={online([])} planned={[]} chainId={56} scope="account" />);
    expect(screen.getByText(/The desk has not acted on this account yet/)).toBeTruthy();
  });

  it("lists events with BscScan links, checks only in the full history", () => {
    render(<WatchLog feed={online(EVENTS)} planned={[]} units={U} chainId={56} scope="account" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const link = screen.getByRole("link", { name: "0xabab...abab" }) as HTMLAnchorElement;
    expect(link.href).toBe(`https://bscscan.com/tx/${TX}`);
    expect(screen.getByText("Restore refused")).toBeTruthy();
    expect(screen.getByText("not sent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Full history" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Checked")).toBeTruthy();
  });

  it("does not link transactions of a local fork to an explorer", () => {
    render(<WatchLog feed={online(EVENTS)} planned={[]} units={U} chainId={31337} scope="account" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("0xabab...abab")).toBeTruthy();
  });
});

describe("refusal log and desk notes", () => {
  it("has an empty state", () => {
    render(<RefusalLog feed={online([])} chainId={56} />);
    expect(screen.getByText(/No refusals yet/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("is explicit when the desk is offline", () => {
    render(
      <>
        <RefusalLog feed={OFF_DOWN} chainId={56} />
        <DeskNotes feed={OFF_UNSET} />
      </>,
    );
    expect(screen.getByText("The desk is offline.")).toBeTruthy();
    expect(screen.getByText("No desk agent is connected.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("shows the refused call, the decoded reason and that it was only simulated", () => {
    render(<RefusalLog feed={online(EVENTS)} units={U} chainId={56} />);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(row.textContent).toContain("restore(2,400 USD1)");
    expect(row.textContent).toContain("from the desk agent");
    expect(row.textContent).toContain("RestoreRefused(NOT_REGULAR)");
    expect(row.textContent).toContain("simulated");
  });

  it("shows only notes the desk wrote", () => {
    render(<DeskNotes feed={online(EVENTS)} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("The restore was refused because New York was closed.")).toBeTruthy();
    cleanup();
    render(<DeskNotes feed={online([EVENTS[2]!])} />);
    expect(screen.getByText(/No notes yet/)).toBeTruthy();
  });

  it("reports the desk state in the bar", () => {
    render(<DeskPill health={{ status: "online", data: { dryRun: true }, fetchedAt: 0 }} />);
    expect(screen.getByRole("status").textContent).toBe("Desk on, dry run");
    cleanup();
    render(<DeskPill health={{ status: "offline", reason: "unreachable", detail: "x" }} />);
    expect(screen.getByRole("status").textContent).toBe("Desk offline");
    cleanup();
    render(<DeskPill health={{ status: "online", data: { ok: false, sender: { halted: { reason: "nonce-gap" } } }, fetchedAt: 0 }} />);
    expect(screen.getByRole("status").textContent).toBe("Desk halted");
    cleanup();
    render(<DeskPill health={undefined} />);
    expect(screen.getByRole("status").textContent).toBe("Checking the desk");
  });
});

describe("loan health", () => {
  it("asks for a wallet when none is connected and shows no loan figures", () => {
    render(<HealthPanel content={{ kind: "disconnected" }} chainName="BNB Chain" now={null} />, { wrapper: Wallets });
    expect(screen.getByText("Connect a wallet to see your loan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.queryByText("Loan to value now")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("lists the installed wallets, or says none was found", () => {
    render(<HealthPanel content={{ kind: "disconnected" }} chainName="BNB Chain" now={null} />, { wrapper: Wallets });
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByText(/No browser wallet found. Install Binance Web3 Wallet, MetaMask or Rabby/)).toBeTruthy();
  });

  it("says the contracts are not deployed", () => {
    render(<HealthPanel content={{ kind: "not-deployed", broken: false }} chainName="BNB Chain" now={null} />);
    expect(screen.getByText("Ballast contracts are not deployed yet")).toBeTruthy();
    expect(screen.getByText("Credit lines and covers open here once the contracts are live on BNB Chain.")).toBeTruthy();
    cleanup();
    // a record that exists but cannot be used is said plainly, without file names or settings
    render(<HealthPanel content={{ kind: "not-deployed", broken: true }} chainName="BNB Chain" now={null} />);
    expect(screen.getByText("The deployment record could not be read")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\.json|DEPLOYMENT|_URL|_ADDRESS/);
  });

  it("says when the chain could not be read and when there is no credit line", () => {
    render(<HealthPanel content={{ kind: "unavailable", detail: "chain read failed: timeout" }} chainName="BNB Chain" now={null} />);
    expect(screen.getByText("Your accounts could not be read")).toBeTruthy();
    cleanup();
    render(<HealthPanel content={{ kind: "none" }} chainName="BNB Chain" now={null} />);
    expect(screen.getByText("No credit line yet")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open a credit line" }) as HTMLAnchorElement).getAttribute("href")).toBe("#manage");
  });

  it("shows the coming closure from the calendar with each stock's measured gap", () => {
    render(<HealthPanel content={{ kind: "none" }} chainName="BNB Chain" now={TUE_1100} />);
    expect(screen.getByText(/Tuesday 4:00 PM to Wednesday 9:30 AM, an overnight window of 17.5 hours/)).toBeTruthy();
    expect(screen.getByText("NVDA 4.2%")).toBeTruthy();
    expect(screen.getByText("TSLA 5.8%")).toBeTruthy();
  });

  it("draws the account from chain figures: now, after the gap, room left", () => {
    render(<HealthPanel content={{ kind: "account", view: VIEW, deskAgent: KEEPER, shielded: false }} chainName="BNB Chain" now={TUE_1100} />);
    expect(screen.getByText("Tonight is an overnight window. Ballast sizes the loan for its worst 1% gap: 4.2%.")).toBeTruthy();
    expect(screen.getByText("54.0%")).toBeTruthy();
    expect(screen.getByText("If NVDAB opens 4.2% lower")).toBeTruthy();
    expect(screen.getAllByText("56.3%").length).toBeGreaterThan(0);
    expect(screen.getByText("18.7 pts")).toBeTruthy();
    expect(screen.getByText("Shield due")).toBeTruthy();
    expect(screen.getByText("$22,368 at $186.40")).toBeTruthy();
    expect(screen.getByText("cushion 3,000 USD1")).toBeTruthy();
    expect(screen.getByText("max 60%, shield 45%")).toBeTruthy();
    expect(screen.getByText(/keeper Ballast desk, auto-restore on, no sale route/)).toBeTruthy();
    const gauges = screen.getAllByRole("img");
    expect(gauges[0]!.getAttribute("aria-label")).toContain("Now 54.0%. After a 4.2% gap 56.3%. After the weekend gap 58.3%. After the earnings gap 56.8%. Shield LTV 45%. Liquidation at 75%.");
  });

  it("draws an account without debt as an empty gauge", () => {
    const empty = { ...VIEW, debt: "0", ltvBps: 0, ltvAfterGapBps: 0, plan: { ...VIEW.plan!, kind: "noop", steps: [], reason: "no debt to shield" } };
    render(<HealthPanel content={{ kind: "account", view: empty, deskAgent: KEEPER, shielded: false }} chainName="BNB Chain" now={TUE_1100} />);
    expect(screen.getByText("No debt")).toBeTruthy();
    expect(screen.getByText("75.0 pts")).toBeTruthy();
    const label = screen.getAllByRole("img")[0]!.getAttribute("aria-label")!;
    expect(label).toContain("Now 0.0%.");
    expect(label).not.toContain("weekend");
    expect(screen.queryByText(/after tonight/)).toBeNull();
  });

  it("does not guess when the venue cannot price the collateral or the oracle is unreadable", () => {
    const blind = { ...VIEW, ltvBps: null, priceUsd: null, ltvAfterGapBps: null, coming: null, plan: null, oracle: null, oracleError: "the Session Oracle could not be read for NVDA" };
    render(<HealthPanel content={{ kind: "account", view: blind, deskAgent: null, shielded: false }} chainName="BNB Chain" now={TUE_1100} />);
    expect(screen.getAllByText("n/a")).toHaveLength(3);
    expect(screen.getByText("The Session Oracle could not be read, so the coming gap is unknown.")).toBeTruthy();
    expect(screen.getByText(/The venue cannot price the collateral right now/)).toBeTruthy();
    expect(screen.getByText("price unavailable")).toBeTruthy();
    expect(screen.getByText("Price unavailable")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the state of the loan", () => {
    expect(healthStatus(VIEW)).toEqual({ text: "Shield due", tone: "no" });
    const calm = { ...VIEW, plan: { ...VIEW.plan!, kind: "noop", reason: "survives a 417 bps gap at HF 1.33" } };
    // "Shielded" only when the desk actually shielded this loan; a loan that needs no shield is not called that
    expect(healthStatus(calm)).toEqual({ text: "Ready for the gap", tone: "ok" });
    expect(healthStatus(calm, false)).toEqual({ text: "Ready for the gap", tone: "ok" });
    expect(healthStatus(calm, true)).toEqual({ text: "Shielded", tone: "ok" });
    // a shield in the past does not hide that another one is due
    expect(healthStatus(VIEW, true)).toEqual({ text: "Shield due", tone: "no" });
    expect(healthStatus({ ...VIEW, plan: { ...VIEW.plan!, kind: "noop", reason: "no closure window known" } }).text).toBe("Watching");
    expect(healthStatus({ ...VIEW, plan: { ...VIEW.plan!, kind: "insufficient" } }).text).toBe("Cushion too small");
    expect(healthStatus({ ...VIEW, liquidated: true }).text).toBe("Liquidated");
    expect(healthStatus({ ...VIEW, debt: "0" }).text).toBe("No debt");
    expect(comingSentence({ ...VIEW, coming: { ...VIEW.coming!, window: "WEEKEND", gapBps: 737, inProgress: true } })).toBe("New York is closed for the weekend. Ballast sizes the loan for the worst 1% gap at the open: 7.4%.");
  });

  it("keeps the gauge's labels apart when gaps land close together", () => {
    const x = (v: number) => 10 + ((v - 30) / 50) * 726;
    const weekend = { value: 58.3, label: "weekend gap", short: "weekend" };
    const earnings = { value: 56.8, label: "earnings gap", short: "earnings" };
    // room on both sides: the lower reads left, the higher right, on one row
    expect(layoutBelow([weekend, earnings], x, 760, 12, false).map((b) => [b.label, b.end, b.row])).toEqual([
      ["earnings gap", true, 0],
      ["weekend gap", false, 0],
    ]);
    // near the right edge the higher label would run over: both read left, on rows of their own
    const tight = layoutBelow([{ ...weekend, value: 74.5 }, { ...earnings, value: 72.6 }], x, 760, 12, false);
    expect(tight.map((b) => [b.label, b.end, b.row])).toEqual([
      ["earnings gap", true, 0],
      ["weekend gap", true, 1],
    ]);
    expect(layoutBelow([weekend], x, 760, 12, false)[0]).toMatchObject({ end: true, row: 0, text: "weekend gap 58.3%" });
    expect(layoutBelow([weekend], x, 420, 15.6, true)[0]!.text).toBe("weekend 58.3%");
    expect(layoutBelow([], x, 760, 12, false)).toEqual([]);
  });

  it("scales the gauge to the loan and the market", () => {
    expect(gaugeScale(41, 75)).toEqual([30, 80]);
    expect(gaugeScale(12, 85)).toEqual([0, 90]);
    expect(gaugeScale(70, 97)).toEqual([30, 100]);
  });
});

describe("refusal slip", () => {
  it("shows the call, the decoded revert, who checked it and that nothing was spent", () => {
    render(
      <RefusalCard
        call="restore(2,400 USD1)"
        at={TUE_1100}
        sim={{ via: "binance", ok: false, error: { name: "RestoreRefused", message: "restore refused by the Session Oracle: NOT_REGULAR (the US market is not in its regular session)", args: ["3"], reason: "NOT_REGULAR" } }}
      />,
    );
    const slip = screen.getByRole("group", { name: "Refused: restore(2,400 USD1)" });
    expect(slip.textContent).toContain("Refused by the contract");
    expect(slip.textContent).toContain("Tue 11:00 New York");
    expect(slip.textContent).toContain("Reverted: RestoreRefused(NOT_REGULAR)");
    expect(slip.textContent).toContain("Binance Transaction API");
    expect(slip.textContent).toContain("Nothing was sent, so no gas was spent.");
  });

  it("links the transaction when it was sent and reverted", () => {
    render(<RefusalCard call="borrow(10 USD1)" at={TUE_1100} sim={{ via: "rpc", ok: false, error: { name: "Reverted", message: "reverted" } }} sent={{ hash: TX, url: `https://bscscan.com/tx/${TX}` }} />);
    expect(screen.getByText("Reverted on chain")).toBeTruthy();
    expect((screen.getByRole("link") as HTMLAnchorElement).href).toBe(`https://bscscan.com/tx/${TX}`);
  });

  it("writes error signatures", () => {
    expect(errorSignature({ name: "ExceedsMandate", message: "", args: ["6300", "6000"] })).toBe("ExceedsMandate(6300, 6000)");
    expect(errorSignature({ name: "BadMarket", message: "", args: [] })).toBe("BadMarket");
  });
});

describe("/app without a wallet, a deployment or a desk", () => {
  const config: AppConfig = {
    chainId: 56,
    deployment: { status: "missing", detail: "no deployment file for chain 56 (contracts/deployments/56.json)" },
    deskAgent: null,
    deskConfigured: false,
    localRpcUrl: null,
  };

  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: 440, height: 440, top: 0, left: 0, right: 440, bottom: 440, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it("renders every panel with an explicit state and asks the chain for nothing", async () => {
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("/api/desk/")) return new Response(JSON.stringify(OFF_UNSET), { headers: { "content-type": "application/json" } });
      throw new Error(`unexpected request ${u}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<AppRoot config={config} />);

    expect(screen.getByRole("heading", { level: 1, name: "Your week" })).toBeTruthy();
    expect(screen.getByText("Contracts not deployed yet.")).toBeTruthy();
    expect(screen.getByText("Connect a wallet to see your loan")).toBeTruthy();
    expect(screen.getByText("Connect a wallet to open or manage a credit line.")).toBeTruthy();
    expect(screen.getByText("Connect a wallet to see your covers and the loans they can protect.")).toBeTruthy();
    expect(await screen.findByText("No desk connected")).toBeTruthy();
    expect((await screen.findAllByText("No desk agent is connected.")).length).toBe(3);
    // the wheel is there (a slider), with the real liquidations as context and no marks of its own
    expect(screen.getByRole("slider", { name: /Your week as a star wheel/ })).toBeTruthy();
    expect(await screen.findByText("Next close in")).toBeTruthy();
    // no wallet in this browser: the menu says so instead of offering a connector that cannot work
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Connect wallet" }));
    expect(screen.getByText(/No browser wallet found/)).toBeTruthy();
    // only the desk was asked; no account, token or market read without a wallet
    expect(fetchSpy.mock.calls.every(([u]) => String(u).startsWith("/api/desk/"))).toBe(true);
    expect(screen.queryByText("Loan to value now")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("amount fields say how they read the input", () => {
  const field = (value: string) => render(<AmountField label="Amount" value={value} onChange={() => {}} unit="NVDAB" decimals={18} />);

  it("shows the parsed amount before anything is simulated", () => {
    field("1,5");
    expect(screen.getByText("Reads as 1.5 NVDAB")).toBeTruthy();
    cleanup();
    field("1,500");
    expect(screen.getByText("Reads as 1,500 NVDAB")).toBeTruthy();
    cleanup();
    field("1,500.25");
    expect(screen.getByText("Reads as 1,500.25 NVDAB")).toBeTruthy();
    cleanup();
    field("0.000001");
    expect(screen.getByText("Reads as 0.000001 NVDAB")).toBeTruthy();
  });

  it("says when the input is not an amount, and nothing when it is empty", () => {
    field("1.500,25");
    expect(screen.getByText(/Not an amount of NVDAB/)).toBeTruthy();
    cleanup();
    field("");
    expect(screen.queryByText(/Reads as|Not an amount/)).toBeNull();
  });
});

describe("your tokenized stocks", () => {
  const ondo = "0xA9ee28c80F960b889dFbD1902055218cBa016f75" as const;
  const held: StocksBody = {
    status: "ok",
    source: "binance",
    binance: "ok",
    stocks: [
      { symbol: "NVDA", issuer: "bStock", token: nvda.collateralToken, tokenSymbol: "NVDAB", rawBalance: (10n * E18).toString(), priceUsd: "231.55", market: { id: "lista:NVDAB_USD1", label: "Lista NVDAB / USD1, Venus NVDAB / USDT" } },
      { symbol: "NVDA", issuer: "Ondo", token: ondo, tokenSymbol: "NVDAon", rawBalance: (2n * E18).toString(), priceUsd: "230", market: null },
    ],
  };

  it("offers a bStock with a market as collateral and marks the rest as having no market", () => {
    const onPick = vi.fn();
    render(<StockPicker stocks={held} loading={false} selected={null} onPick={onPick} />);
    const rows = within(screen.getByRole("group", { name: "Your tokenized stocks" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("10 NVDAB");
    expect(rows[0]!.textContent).toContain("NVDA as a bStock, about $2,316");
    expect(rows[1]!.textContent).toContain("2 NVDAon");
    expect(rows[1]!.textContent).toContain("no market");
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Use as collateral" }));
    expect(onPick).toHaveBeenCalledWith("lista:NVDAB_USD1");
    expect(screen.getByText("From the Binance Wallet API.")).toBeTruthy();
  });

  it("says where the list came from when Binance did not answer, and when the wallet holds none", () => {
    render(<StockPicker stocks={{ ...held, source: "chain", binance: "unavailable", detail: "40304 restricted" }} loading={false} selected={null} onPick={() => {}} />);
    expect(screen.getByText("Binance API unavailable: read from BNB Chain instead, without prices.")).toBeTruthy();
    cleanup();
    render(<StockPicker stocks={{ status: "ok", source: "binance", binance: "ok", stocks: [] }} loading={false} selected={null} onPick={() => {}} />);
    expect(screen.getByText(/holds none of the tokenized stocks Ballast knows/)).toBeTruthy();
    cleanup();
    render(<StockPicker stocks={{ status: "unavailable", binance: "unavailable", detail: "x" }} loading={false} selected={null} onPick={() => {}} />);
    expect(screen.getByText("Binance API unavailable, and BNB Chain did not answer either.")).toBeTruthy();
    cleanup();
    render(<StockPicker stocks={undefined} loading selected={null} onPick={() => {}} />);
    expect(screen.getByText("Reading your holdings...")).toBeTruthy();
  });

  it("picking a stock sets the market and its mandate defaults in the create form", () => {
    const spy = marketById("lista:SPYB_USD1")!;
    const market = (m: typeof spy, lltvBps: number): MarketView => ({
      id: m.id,
      venue: m.venue,
      label: m.label,
      symbol: m.symbol,
      collateralSymbol: m.collateralSymbol,
      loanSymbol: m.loanSymbol,
      collateralToken: m.collateralToken,
      loanToken: m.loanToken,
      lltvBps,
      marketParams: { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: KEEPER, irm: KEEPER, lltv: (BigInt(lltvBps) * 10n ** 14n).toString() },
      path: deleveragePathFor(m),
    });
    const runner = { chainId: 56, simulate: vi.fn(), send: vi.fn(), wait: vi.fn() };
    render(
      <TxRunnerContext.Provider value={runner as never}>
        <CreateAccountForm deployment={DEPLOYMENT} owner={OWNER} deskAgent={KEEPER} markets={[market(spy, 8500), market(nvda, 7500)]} stocks={held} />
      </TxRunnerContext.Provider>,
    );
    expect((screen.getByLabelText("Market") as HTMLSelectElement).value).toBe("lista:SPYB_USD1");
    expect((screen.getByLabelText("Max loan to value") as HTMLInputElement).value).toBe("68");
    fireEvent.click(screen.getByRole("button", { name: "Use as collateral" }));
    expect((screen.getByLabelText("Market") as HTMLSelectElement).value).toBe("lista:NVDAB_USD1");
    expect((screen.getByLabelText("Max loan to value") as HTMLInputElement).value).toBe("60");
    expect(screen.getByRole("button", { name: "Selected" })).toBeTruthy();
    // picking a stock simulates and sends nothing
    expect(runner.simulate).not.toHaveBeenCalled();
  });
});
