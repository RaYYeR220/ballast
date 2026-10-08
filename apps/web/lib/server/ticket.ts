/* A short-lived ticket for one exact transaction the server itself built (a swap from the Binance Trading API).
   /api/simulate takes calls to Ballast contracts, accounts and configured tokens; a swap goes to a router that
   is on no list, so the route that built it signs it and the simulate route checks the signature. The key is
   derived from the Binance API secret, which every instance of the server has, so no state is shared. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { keccak256, type Hex } from "viem";

export const TICKET_TTL_SEC = 300;

export interface TicketTx {
  chainId: number;
  from: string;
  to: string;
  data: Hex;
  value: bigint;
}

const message = (tx: TicketTx, exp: number) => `ballast-sim|${tx.chainId}|${tx.from.toLowerCase()}|${tx.to.toLowerCase()}|${keccak256(tx.data)}|${tx.value}|${exp}`;
const mac = (secret: string, text: string) => createHmac("sha256", `ballast-sim-ticket:${secret}`).update(text).digest("hex");

export function issueTicket(secret: string, tx: TicketTx, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + TICKET_TTL_SEC;
  return `${exp}.${mac(secret, message(tx, exp))}`;
}

export function checkTicket(secret: string, ticket: unknown, tx: TicketTx, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  if (typeof ticket !== "string" || ticket.length > 100) return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(ticket);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < nowSec || exp > nowSec + TICKET_TTL_SEC) return false;
  const want = Buffer.from(mac(secret, message(tx, exp)), "hex");
  const got = Buffer.from(m[2] as string, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
