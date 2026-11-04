// The preprod loan setup, shared by scripts/loans.ts and scripts/position.ts:
// the test wallet, the recorded loan config, and the scripts it produces.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddressDetails, Lucid, type LucidEvolution, type Script } from "@lucid-evolution/lucid";
import { KEYS_DIR, REPO_ROOT, loadConfig } from "./config.js";
import { providerFromConfig } from "./provider.js";
import { lendingScript, poolAddress, poolScript, testTokens, unit, type LoanConfig } from "./lending.js";
import type { Loans } from "./loans.js";
import { koios } from "./koios.js";

/** Test values for preprod, not proposals (open question 6). */
export const PREPROD_TEST_VALUES = { maxAgeMs: 3_600_000, maxLtvBps: 5_000, rateBps: 1_000 };

export async function preprod() {
  const cfg = loadConfig();
  const net = cfg.network.toLowerCase();
  const wallet = JSON.parse(readFileSync(path.join(KEYS_DIR, `${net}-wallet.json`), "utf8")) as { mnemonic: string; address: string };
  const ownerKey = getAddressDetails(wallet.address).paymentCredential!.hash;
  const lucid: LucidEvolution = await Lucid(providerFromConfig(cfg), cfg.network);
  lucid.selectWallet.fromSeed(wallet.mnemonic);

  const depFile = path.join(REPO_ROOT, "deployments", `${net}.json`);
  const dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : { vaults: [] };
  const save = () => writeFileSync(depFile, JSON.stringify(dep, null, 2) + "\n");

  /** The loan config: as recorded, or the test values with this wallet's test tokens. */
  const recorded = dep.loans?.config as LoanConfig | undefined;
  const t = testTokens(ownerKey);
  const loanCfg: LoanConfig = recorded ?? { stable: t.tUSD, poolToken: t.pool, oracleToken: t.oracle, ...PREPROD_TEST_VALUES };
  const lending = lendingScript(loanCfg);
  const pool = poolScript(loanCfg, lending);
  const l: Loans = { cfg: loanCfg, lending, pool, poolAddress: poolAddress(cfg.network, pool) };

  const v0File = path.join(REPO_ROOT, "deployments", "scripts", "lending-v0.json");
  const v0 = JSON.parse(readFileSync(v0File, "utf8")) as { hash: string; type: "PlutusV3"; cborHex: string };
  const lendingV0: Script = { type: v0.type, script: v0.cborHex };

  const state = async () => ({
    poolUtxo: (await lucid.utxosAt(l.poolAddress)).find((u) => u.assets[unit(loanCfg.poolToken)] === 1n),
    oracle: (await lucid.utxosAtWithUnit(wallet.address, unit(loanCfg.oracleToken)))[0],
  });

  return { cfg, net, wallet, ownerKey, lucid, dep, depFile, save, isOpen: !!recorded, l, lendingV0, state, k: koios(cfg) };
}

export async function submitAndRecord(p: Awaited<ReturnType<typeof preprod>>, tx: { complete: () => Promise<any> }, log: Record<string, unknown>) {
  const built = await tx.complete();
  const txHash = await (await built.sign.withWallet().complete()).submit();
  const ok = await p.k.txConfirmed(txHash);
  console.log(`confirmed     : ${ok ? "yes" : "not yet"} https://preprod.cardanoscan.io/transaction/${txHash}`);
  p.dep.loans ??= {};
  p.dep.loans.log ??= [];
  p.dep.loans.log.push({ ...log, txHash, at: new Date().toISOString() });
  p.save();
  return txHash;
}
