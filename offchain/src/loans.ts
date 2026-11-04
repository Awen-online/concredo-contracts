// Transaction builders for the day 4 flows: test tokens, pool, mock oracle,
// borrow and repay. Shared by scripts/loans.ts, scripts/position.ts and the
// Emulator tests, so the tests run exactly what goes to preprod.

import type { LucidEvolution, Script, UTxO } from "@lucid-evolution/lucid";
import { type BucketParams } from "./blueprint.js";
import {
  Action,
  owed,
  PoolAction,
  positionDatum,
  readPosition,
  readPriceFeed,
  priceFeedDatum,
  testTokens,
  unit,
  type LoanConfig,
} from "./lending.js";

export interface Loans {
  cfg: LoanConfig;
  lending: Script;
  pool: Script;
  poolAddress: string;
}

/** The start of the slot holding `ms`: the time a script sees for a bound set at `ms`. */
const slotStart = (lucid: LucidEvolution, ms: number) => lucid.slotToUnixTime(lucid.unixTimeToSlot(ms));

/** Mint the test tokens, open the pool with `supply` tUSD, post the first
 *  price, and leave `spare` tUSD in the admin wallet (to pay interest with). */
export function openPool(lucid: LucidEvolution, adminKeyHash: string, oracleAddress: string, l: Loans, supply: bigint, spare: bigint, price: bigint, now: number) {
  const t = testTokens(adminKeyHash);
  return lucid.newTx()
    .mintAssets({ [unit(t.tUSD)]: supply + spare, [unit(t.pool)]: 1n, [unit(t.oracle)]: 1n })
    .attach.MintingPolicy(t.policy)
    .pay.ToContract(l.poolAddress, { kind: "inline", value: "d87980" }, { [unit(t.pool)]: 1n, [unit(t.tUSD)]: supply })
    .pay.ToAddressWithData(oracleAddress, { kind: "inline", value: priceFeedDatum(price, BigInt(slotStart(lucid, now))) }, { [unit(t.oracle)]: 1n })
    .addSigner(oracleAddress);
}

/** Replace the mock oracle's price. The oracle UTxO sits at the admin's key address. */
export function postPrice(lucid: LucidEvolution, oracle: UTxO, l: Loans, price: bigint, now: number) {
  return lucid.newTx()
    .collectFrom([oracle])
    .pay.ToAddressWithData(oracle.address, { kind: "inline", value: priceFeedDatum(price, BigInt(slotStart(lucid, now))) }, { [unit(l.cfg.oracleToken)]: 1n });
}

/** A validity window the oracle price covers: from the later of its post time
 *  and a minute ago, to the earlier of ten minutes ahead and its expiry. */
export function window(lucid: LucidEvolution, l: Loans, oracle: UTxO, now: number) {
  const { postedAt } = readPriceFeed(oracle.datum!);
  const from = Math.max(Number(postedAt), slotStart(lucid, now - 60_000));
  const to = slotStart(lucid, Math.min(now + 600_000, Number(postedAt) + l.cfg.maxAgeMs));
  if (to <= now) throw new Error(`oracle price posted ${new Date(Number(postedAt)).toISOString()} is too old; post a new one`);
  return { from, to };
}

interface Step {
  position: UTxO;
  vault: BucketParams;
  owner: string; // owner's address, the required signer
  ownerKeyHash: string;
  poolUtxo: UTxO;
  oracle: UTxO;
  now: number;
  /** Override the recorded debt (for refusal checks). */
  claimDebt?: bigint;
}

/** Borrow `amount` tUSD: the position's loan grows by it (plus interest so far). */
export function borrow(lucid: LucidEvolution, l: Loans, s: Step & { amount: bigint }) {
  const { from, to } = window(lucid, l, s.oracle, s.now);
  const p = readPosition(s.position.datum!);
  const debt = s.claimDebt ?? owed(l.cfg, p.debt, p.since, BigInt(to)) + s.amount;
  return lending(lucid, l, s, Action.borrow(s.amount), -s.amount, debt, from, to);
}

/** Repay `amount` tUSD, or everything owed when `amount` is "all". */
export function repay(lucid: LucidEvolution, l: Loans, s: Step & { amount: bigint | "all" }) {
  const { from, to } = window(lucid, l, s.oracle, s.now);
  const p = readPosition(s.position.datum!);
  const due = owed(l.cfg, p.debt, p.since, BigInt(to));
  const amount = s.amount === "all" ? due : s.amount;
  return { amount, tx: lending(lucid, l, s, Action.repay(amount), amount, s.claimDebt ?? due - amount, from, to) };
}

function lending(lucid: LucidEvolution, l: Loans, s: Step, action: string, poolDelta: bigint, debt: bigint, from: number, to: number) {
  const stable = unit(l.cfg.stable);
  const poolAssets = { ...s.poolUtxo.assets, [stable]: (s.poolUtxo.assets[stable] ?? 0n) + poolDelta };
  if (poolAssets[stable] === 0n) delete poolAssets[stable];
  return lucid.newTx()
    .collectFrom([s.position], action)
    .collectFrom([s.poolUtxo], PoolAction.lend())
    .readFrom([s.oracle])
    .attach.SpendingValidator(l.lending)
    .attach.SpendingValidator(l.pool)
    .pay.ToContract(s.position.address, { kind: "inline", value: positionDatum(s.ownerKeyHash, s.vault, debt, BigInt(to)) }, { lovelace: s.position.assets.lovelace })
    .pay.ToContract(s.poolUtxo.address, { kind: "inline", value: s.poolUtxo.datum! }, poolAssets)
    .addSigner(s.owner)
    .validFrom(from)
    .validTo(to);
}
