// @vitest-environment jsdom
/* The write path end to end, with a stubbed chain: the create-account form builds calldata with the SDK, the
   simulation goes through the /api/simulate handler and eth_call on a stub transport, a refusal comes back
   decoded and is shown as the refusal slip, and nothing is sent unless the simulation passes. */
import { ballastFactoryAbi, listaAccountAbi } from "@ballast/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, stringToHex, type Hex, type Log } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateAccountForm } from "../components/app/CreateAccount";
import { TxRunnerContext, type TxRunner } from "../components/app/TxFlow";
import { deleveragePathFor } from "../lib/markets";
import { serverEnv } from "../lib/server/env";
import { handleSimulate, simulateDeps, simulateGuard } from "../lib/server/handlers/simulate";
import { requestSimulation } from "../lib/sim";
import type { MarketView } from "../lib/views";
import { KEEPER, nvda, OWNER, VIEW } from "./fixtures";
import { addr, DEPLOYMENT, errorData, stubClient, type CallAnswer } from "./helpers";

afterEach(cleanup);

const MARKET: MarketView = {
  id: nvda.id,
  venue: "lista",
  label: nvda.label,
  symbol: "NVDA",
  collateralSymbol: "NVDAB",
  loanSymbol: "USD1",
  collateralToken: nvda.collateralToken,
  loanToken: nvda.loanToken,
  lltvBps: 7500,
  marketParams: VIEW.lista!.marketParams,
  path: deleveragePathFor(nvda),
};
const NEW_ACCOUNT = addr(0xcafe);
const TX1: Hex = `0x${"a1".repeat(32)}`;
const TX2: Hex = `0x${"a2".repeat(32)}`;

/** A runner whose simulation runs the real route handler over a stub transport; sends are recorded. */
function harness(answer: (call: { to: string; data: Hex }) => CallAnswer) {
  const { client, calls } = stubClient(answer);
  const deps = simulateDeps(serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337" }), client);
  // the real allowlist: the factory by address, the new account because the factory vouches for it
  const isAccount = vi.fn(async ({ args }: { args: readonly unknown[] }) => args[0] === NEW_ACCOUNT);
  const guard = simulateGuard({ chainId: 31337, deployment: DEPLOYMENT, client: { readContract: isAccount } as never, ticketSecret: null });
  // a page of the site makes the request: the browser adds Origin
  const route = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    handleSimulate(new Request("http://app.test/api/simulate", { ...init, headers: { ...(init?.headers as Record<string, string>), origin: "http://app.test" } }), deps, guard),
  );
  const created: Log = {
    address: DEPLOYMENT.factory,
    topics: encodeEventTopics({ abi: ballastFactoryAbi, eventName: "AccountCreated", args: { owner: OWNER, account: NEW_ACCOUNT } }) as Log["topics"],
    data: encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [1, stringToHex("NVDA", { size: 32 })]),
    blockHash: `0x${"00".repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: TX1,
    transactionIndex: 0,
    removed: false,
  };
  const send = vi.fn<TxRunner["send"]>(async (tx) => (tx.to === DEPLOYMENT.factory ? TX1 : TX2));
  const wait = vi.fn<TxRunner["wait"]>(async (hash) => ({ hash, status: "success", logs: hash === TX1 ? [created] : [] }));
  const runner: TxRunner = {
    chainId: 31337,
    simulate: (tx, from) => requestSimulation({ from, to: tx.to, data: tx.data, value: tx.value.toString() }, route as unknown as typeof fetch),
    send,
    wait,
  };
  return { runner, send, wait, route, calls, created };
}

function renderForm(runner: TxRunner, props: Partial<Parameters<typeof CreateAccountForm>[0]> = {}) {
  const onCreated = vi.fn();
  render(
    <TxRunnerContext.Provider value={runner}>
      <CreateAccountForm deployment={DEPLOYMENT} owner={OWNER} deskAgent={KEEPER} markets={[MARKET]} onCreated={onCreated} {...props} />
    </TxRunnerContext.Provider>,
  );
  return { onCreated };
}

describe("create account -> simulate -> refusal decoded", () => {
  it("shows the contract's refusal as a slip and sends nothing", async () => {
    const h = harness(() => ({ revert: errorData("BadMarket") }));
    renderForm(h.runner);
    // defaults sized to the market: 60% / 45% / 1%, the desk agent as keeper
    expect((screen.getByLabelText("Max loan to value") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Shield loan to value") as HTMLInputElement).value).toBe("45");
    expect(screen.getByText(`The Ballast desk agent, ${KEEPER}`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    await screen.findByText("Refused by the contract");

    // the simulated call is the SDK's createListaAccount on the factory, from the owner
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.to.toLowerCase()).toBe(DEPLOYMENT.factory.toLowerCase());
    const call = decodeFunctionData({ abi: ballastFactoryAbi, data: h.calls[0]!.data });
    expect(call.functionName).toBe("createListaAccount");
    expect(call.args![2]).toBe(KEEPER);
    expect(call.args![3]).toEqual({ maxLtvBps: 6000, shieldLtvBps: 4500, maxSlippageBps: 100, autoRestore: true });

    expect(screen.getByText("Reverted: BadMarket")).toBeTruthy();
    expect(screen.getByText("the market does not match the symbol or venue")).toBeTruthy();
    expect(screen.getByText("Simulated, not sent")).toBeTruthy();
    expect(screen.getByText("eth_call on BNB Chain")).toBeTruthy();
    expect(screen.getByText("Nothing was sent, so no gas was spent.")).toBeTruthy();
    expect(screen.getByText("createListaAccount(NVDAB / USD1, NVDA)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send from wallet" })).toBeNull();
    expect(h.send).not.toHaveBeenCalled();

    // back to the form keeps the inputs
    fireEvent.click(screen.getByRole("button", { name: "Back to the form" }));
    expect((screen.getByLabelText("Max loan to value") as HTMLInputElement).value).toBe("60");
  });

  it("names the oracle's reason when a refusal carries one", async () => {
    const h = harness(() => ({ revert: errorData("RestoreRefused", [3]) }));
    renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    await screen.findByText("Reverted: RestoreRefused(NOT_REGULAR)");
    expect(screen.getByText(/the US market is not in its regular session/)).toBeTruthy();
  });

  it("says when the simulator itself is down, and still sends nothing", async () => {
    const h = harness(() => ({ fail: "socket hang up" }));
    renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    await screen.findByText(/The simulator did not answer/);
    expect(screen.queryByRole("button", { name: "Send from wallet" })).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("sends only after a passing simulation, then fixes the deleverage route as its own step", async () => {
    const h = harness(() => ({ ok: "0x" }));
    const { onCreated } = renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    await screen.findByText("Simulation passed");
    expect(h.send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send from wallet" }));
    await screen.findByText("Fix the deleverage route");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0].to).toBe(DEPLOYMENT.factory);
    // the sender is pinned to the account the form was filled for
    expect(h.send.mock.calls[0]![1]).toBe(OWNER);
    expect(onCreated).not.toHaveBeenCalled();

    // the second transaction targets the new account from the AccountCreated log and is simulated before it is offered
    await screen.findByText("Simulation passed");
    await waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1]!.to.toLowerCase()).toBe(NEW_ACCOUNT.toLowerCase());
    expect(decodeFunctionData({ abi: listaAccountAbi, data: h.calls[1]!.data })).toMatchObject({ functionName: "setDeleveragePath", args: [MARKET.path!.hex] });

    fireEvent.click(screen.getByRole("button", { name: "Send from wallet" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(NEW_ACCOUNT));
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]![0].to).toBe(NEW_ACCOUNT);
  });

  it("reports a declined wallet request and lets the user retry", async () => {
    const h = harness(() => ({ ok: "0x" }));
    h.send.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" }));
    renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send from wallet" }));
    await screen.findByText("You declined the request in your wallet. Nothing was sent.");
    // no hash came back, so nothing was sent and sending again is safe
    expect(screen.getByRole("button", { name: "Send from wallet" })).toBeTruthy();
  });

  it("blocks a mandate the contract would refuse, before any simulation", () => {
    const h = harness(() => ({ ok: "0x" }));
    renderForm(h.runner);
    fireEvent.change(screen.getByLabelText("Max loan to value"), { target: { value: "80" } });
    expect(screen.getByText("Max LTV must stay below the market's liquidation LTV of 75%.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review and simulate" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.route).not.toHaveBeenCalled();
  });

  it("refuses to open an account without a keeper to name", () => {
    const h = harness(() => ({ ok: "0x" }));
    renderForm(h.runner, { deskAgent: null });
    expect(screen.getByText(/address of the desk agent is not known right now/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review and simulate" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when no market can be read", () => {
    const h = harness(() => ({ ok: "0x" }));
    renderForm(h.runner, { markets: [{ ...MARKET, marketParams: null, error: "could not be read" }] });
    expect(screen.getByText(/No market can be read right now/)).toBeTruthy();
  });
});

describe("a transaction that was sent is never offered again", () => {
  const TX1R: Hex = `0x${"b7".repeat(32)}`;

  it("keeps the hash when no receipt arrives, and can only look for it again", async () => {
    const h = harness(() => ({ ok: "0x" }));
    h.wait.mockRejectedValueOnce(Object.assign(new Error("Timed out while waiting for transaction"), { name: "WaitForTransactionReceiptTimeoutError", shortMessage: "Timed out while waiting for the transaction" }));
    renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send from wallet" }));

    await screen.findByText(/its receipt has not been found yet/);
    expect(screen.getByText(/it is not offered for sending again/)).toBeTruthy();
    // the only actions: look again (and the hash to check elsewhere); no way to send a second time
    expect(screen.queryByRole("button", { name: "Send from wallet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simulate again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the form" })).toBeNull();
    expect(screen.getByText(/0xa1a1...a1a1/)).toBeTruthy();

    // still missing: stays put, with the same hash
    h.wait.mockRejectedValueOnce(new Error("still nothing"));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(h.wait).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Check again" });
    expect(h.wait.mock.calls[1]![0]).toBe(TX1);

    // found: the flow goes on to the next step from the receipt, having sent exactly once
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Fix the deleverage route");
    expect(h.wait.mock.calls[2]![0]).toBe(TX1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("follows a sped-up transaction by its new hash", async () => {
    const h = harness(() => ({ ok: "0x" }));
    h.wait.mockResolvedValueOnce({ hash: TX1R, status: "success", logs: [h.created], replaced: "repriced" });
    renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send from wallet" }));
    // the account from the replacement's receipt is used for the next step
    await screen.findByText("Fix the deleverage route");
    await waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1]!.to.toLowerCase()).toBe(NEW_ACCOUNT.toLowerCase());
  });

  it("does not count a cancelled transaction as done", async () => {
    const h = harness(() => ({ ok: "0x" }));
    h.wait.mockResolvedValueOnce({ hash: TX1R, status: "success", logs: [], replaced: "cancelled" });
    const { onCreated } = renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send from wallet" }));
    await screen.findByText(/You cancelled this transaction in your wallet/);
    expect(screen.getByText(/0xb7b7...b7b7/)).toBeTruthy();
    expect(screen.queryByText("Fix the deleverage route")).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    // the nonce is spent by the cancellation, so starting over (with a fresh simulation) is safe
    expect(screen.getByRole("button", { name: "Simulate again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send from wallet" })).toBeNull();
  });

  it("does not count a different transaction in its place as done", async () => {
    const h = harness(() => ({ ok: "0x" }));
    h.wait.mockResolvedValueOnce({ hash: TX1R, status: "success", logs: [], replaced: "replaced" });
    renderForm(h.runner);
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send from wallet" }));
    await screen.findByText(/Your wallet replaced this transaction with a different one/);
    expect(screen.queryByText("Fix the deleverage route")).toBeNull();
  });

  it("refuses a target the server does not vouch for before simulating it", async () => {
    const h = harness(() => ({ ok: "0x" }));
    const stranger = { ...MARKET };
    render(
      <TxRunnerContext.Provider value={h.runner}>
        <CreateAccountForm deployment={{ ...DEPLOYMENT, factory: addr(0x5eed) }} owner={OWNER} deskAgent={KEEPER} markets={[stranger]} />
      </TxRunnerContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review and simulate" }));
    await screen.findByText(/The simulator did not answer: this address is not a Ballast contract/);
    expect(h.calls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Send from wallet" })).toBeNull();
  });
});
