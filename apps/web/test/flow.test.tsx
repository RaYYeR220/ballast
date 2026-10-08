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
import { handleSimulate, simulateDeps } from "../lib/server/handlers/simulate";
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
  const route = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => handleSimulate(new Request("http://app.test/api/simulate", init), deps));
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
  const runner: TxRunner = {
    chainId: 31337,
    simulate: (tx, from) => requestSimulation({ from, to: tx.to, data: tx.data, value: tx.value.toString() }, route as unknown as typeof fetch),
    send,
    wait: async (hash) => ({ hash, status: "success", logs: hash === TX1 ? [created] : [] }),
  };
  return { runner, send, route, calls };
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
    await screen.findByText("You declined the request in your wallet.");
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
    expect(screen.getByText(/No desk agent address is known/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review and simulate" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when no market can be read", () => {
    const h = harness(() => ({ ok: "0x" }));
    renderForm(h.runner, { markets: [{ ...MARKET, marketParams: null, error: "could not be read" }] });
    expect(screen.getByText(/No market can be read right now/)).toBeTruthy();
  });
});
