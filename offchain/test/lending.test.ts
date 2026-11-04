// Offline checks of the lending validator v1 and the pool in the Emulator
// (phase 2 evaluated). The real compiled scripts run, so each accepted spend
// means the on-chain rebuild of the vault hash matched the real stake part of
// the address, and each loan step passed the on-chain oracle and LTV checks.

import { describe, expect, it } from "vitest";
import {
  Emulator,
  generateEmulatorAccount,
  getAddressDetails,
  Lucid,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  Action,
  lendingScript,
  maxLoan,
  poolAddress,
  poolScript,
  positionAddress,
  positionDatum,
  readPosition,
  testTokens,
  unit,
  type LoanConfig,
} from "../src/lending.js";
import { borrow, openPool, postPrice, repay, type Loans } from "../src/loans.js";
import { bech32 } from "./bech32.js";

const A = { drepId: bech32("drep", "aa".repeat(28)), approvedPoolKeyHashes: [] as string[] };
const B = { drepId: bech32("drep", "bb".repeat(28)), approvedPoolKeyHashes: [] as string[] };
// Test values only (open question 6): 10 minute price, 50% LTV, 10% a year.
const PRICE = 700_000n; // 0.70 tUSD per ADA, a fixed test price
const SUPPLY = 1_000_000_000n; // 1,000 tUSD

async function setup() {
  const owner = generateEmulatorAccount({ lovelace: 500_000_000n });
  const stranger = generateEmulatorAccount({ lovelace: 100_000_000n });
  const emulator = new Emulator([owner, stranger]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(owner.seedPhrase);
  const ownerKey = getAddressDetails(owner.address).paymentCredential!.hash;
  const t = testTokens(ownerKey);
  const cfg: LoanConfig = { stable: t.tUSD, poolToken: t.pool, oracleToken: t.oracle, maxAgeMs: 600_000, maxLtvBps: 5_000, rateBps: 1_000 };
  const lending = lendingScript(cfg);
  const pool = poolScript(cfg, lending);
  const l: Loans = { cfg, lending, pool, poolAddress: poolAddress("Custom", pool) };
  return { emulator, lucid, owner, stranger, ownerKey, l };
}

async function submit(emulator: Emulator, tx: { complete: () => Promise<any> }) {
  const hash = await (await (await tx.complete()).sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  return hash;
}

async function deposit(lucid: LucidEvolution, emulator: Emulator, l: Loans, ownerKey: string, lovelace: bigint): Promise<UTxO> {
  const addr = positionAddress("Custom", A, l.lending);
  await submit(emulator, lucid.newTx().pay.ToContract(addr, { kind: "inline", value: positionDatum(ownerKey, A) }, { lovelace }));
  const [u] = await lucid.utxosAt(addr);
  return u;
}

/** Owner with a 100 ADA position, an open pool and a fresh price. */
async function withPool() {
  const s = await setup();
  await submit(s.emulator, openPool(s.lucid, s.ownerKey, s.owner.address, s.l, SUPPLY, 10_000_000n, PRICE, s.emulator.now()));
  const position = await deposit(s.lucid, s.emulator, s.l, s.ownerKey, 100_000_000n);
  const state = async () => ({
    position: (await s.lucid.utxosAt(position.address))[0],
    poolUtxo: (await s.lucid.utxosAt(s.l.poolAddress))[0],
    oracle: (await s.lucid.utxosAtWithUnit(s.owner.address, unit(s.l.cfg.oracleToken)))[0],
  });
  const step = async () => ({ ...(await state()), vault: A, owner: s.owner.address, ownerKeyHash: s.ownerKey, now: s.emulator.now() });
  return { ...s, state, step };
}

describe("lending validator v1: positions", () => {
  it("deposit lands at the vault's full address", async () => {
    const { emulator, lucid, ownerKey, l } = await setup();
    const u = await deposit(lucid, emulator, l, ownerKey, 100_000_000n);
    const d = getAddressDetails(u.address);
    expect(d.paymentCredential?.type).toBe("Script");
    expect(d.stakeCredential?.type).toBe("Script");
  });

  it("refuses an adjust that re-points the stake part to another vault", async () => {
    const { emulator, lucid, owner, ownerKey, l } = await setup();
    const u = await deposit(lucid, emulator, l, ownerKey, 100_000_000n);
    await expect(
      lucid.newTx()
        .collectFrom([u], Action.adjust())
        .pay.ToContract(positionAddress("Custom", B, l.lending), { kind: "inline", value: positionDatum(ownerKey, A) }, { lovelace: 100_000_000n })
        .attach.SpendingValidator(l.lending)
        .addSigner(owner.address)
        .complete(),
    ).rejects.toThrow(/failed script execution Spend/);
  });

  it("moves to another DRep's genuine vault", async () => {
    const { emulator, lucid, owner, ownerKey, l } = await setup();
    const u = await deposit(lucid, emulator, l, ownerKey, 100_000_000n);
    await submit(emulator, lucid.newTx()
      .collectFrom([u], Action.move(B))
      .pay.ToContract(positionAddress("Custom", B, l.lending), { kind: "inline", value: positionDatum(ownerKey, B) }, { lovelace: 100_000_000n })
      .attach.SpendingValidator(l.lending)
      .addSigner(owner.address));
    expect(await lucid.utxosAt(positionAddress("Custom", B, l.lending))).toHaveLength(1);
  });

  it("owner withdraws; a stranger cannot", async () => {
    const { emulator, lucid, owner, stranger, ownerKey, l } = await setup();
    const u = await deposit(lucid, emulator, l, ownerKey, 100_000_000n);
    lucid.selectWallet.fromSeed(stranger.seedPhrase);
    await expect(
      lucid.newTx().collectFrom([u], Action.withdraw()).attach.SpendingValidator(l.lending).addSigner(stranger.address).complete(),
    ).rejects.toThrow(/failed script execution Spend/);
    lucid.selectWallet.fromSeed(owner.seedPhrase);
    await submit(emulator, lucid.newTx().collectFrom([u], Action.withdraw()).attach.SpendingValidator(l.lending).addSigner(owner.address));
  });
});

describe("lending validator v1: loans", () => {
  it("borrows within the LTV, accrues interest, repays in full, then withdraws", async () => {
    const s = await withPool();
    await submit(s.emulator, borrow(s.lucid, s.l, { ...(await s.step()), amount: 30_000_000n }));
    let { position, poolUtxo } = await s.state();
    expect(readPosition(position.datum!).debt).toBe(30_000_000n);
    expect(poolUtxo.assets[unit(s.l.cfg.stable)]).toBe(SUPPLY - 30_000_000n);

    // A loan blocks withdrawal.
    await expect(
      s.lucid.newTx().collectFrom([position], Action.withdraw()).attach.SpendingValidator(s.l.lending).addSigner(s.owner.address).complete(),
    ).rejects.toThrow(/failed script execution Spend/);

    // Some minutes later, with a new price, repay everything owed.
    s.emulator.awaitSlot(300);
    await submit(s.emulator, postPrice(s.lucid, (await s.state()).oracle, s.l, PRICE, s.emulator.now()));
    const r = repay(s.lucid, s.l, { ...(await s.step()), amount: "all" });
    expect(r.amount).toBeGreaterThan(30_000_000n); // interest accrued
    await submit(s.emulator, r.tx);
    ({ position, poolUtxo } = await s.state());
    expect(readPosition(position.datum!).debt).toBe(0n);
    expect(poolUtxo.assets[unit(s.l.cfg.stable)]).toBe(SUPPLY - 30_000_000n + r.amount);

    await submit(s.emulator, s.lucid.newTx().collectFrom([position], Action.withdraw()).attach.SpendingValidator(s.l.lending).addSigner(s.owner.address));
  });

  it("refuses a loan over the LTV", async () => {
    const s = await withPool();
    const over = maxLoan(s.l.cfg, 100_000_000n, PRICE) + 1n;
    await expect(borrow(s.lucid, s.l, { ...(await s.step()), amount: over }).complete()).rejects.toThrow(/failed script execution Spend/);
    await submit(s.emulator, borrow(s.lucid, s.l, { ...(await s.step()), amount: over - 1n }));
  });

  it("refuses a borrow that records less debt than it takes", async () => {
    const s = await withPool();
    await expect(
      borrow(s.lucid, s.l, { ...(await s.step()), amount: 30_000_000n, claimDebt: 1n }).complete(),
    ).rejects.toThrow(/failed script execution Spend/);
  });

  it("will not build a borrow against a stale price (the script refusal is an Aiken test)", async () => {
    const s = await withPool();
    s.emulator.awaitSlot(601);
    const step = await s.step();
    expect(() => borrow(s.lucid, s.l, { ...step, amount: 1_000_000n })).toThrow(/too old/);
  });

  it("pool stablecoin cannot leave with a plain withdraw", async () => {
    const s = await withPool();
    const { position, poolUtxo } = await s.state();
    await expect(
      s.lucid.newTx()
        .collectFrom([position], Action.withdraw())
        .collectFrom([poolUtxo], "d87980")
        .attach.SpendingValidator(s.l.lending)
        .attach.SpendingValidator(s.l.pool)
        .addSigner(s.owner.address)
        .complete(),
    ).rejects.toThrow(/failed script execution Spend/);
  });
});
