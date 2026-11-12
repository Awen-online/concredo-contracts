// The preprod stablecoin pool and mock oracle (day 4).
//
//   npm run loans -- open  [--supply N] [--spare N] [--usd P] [--submit]
//   npm run loans -- price [--usd P] [--submit]
//   npm run loans -- status
//
// open  : mints the test tokens (tUSD, POOL, ORACLE) under a native policy
//         signed by the test wallet, opens the pool with N tUSD (default 5,000),
//         leaves --spare tUSD in the wallet for paying interest (default 100),
//         and posts the first price. Records the loan config in
//         deployments/preprod.json; every later script hash follows from it.
// price : posts a new price. Without --usd it reads ADA/USD from CoinGecko's
//         public price API, so the mock oracle tracks the real price.
//
// The oracle is a mock: one key posts the price. Several feeds, a halt on
// disagreement and a fallback are open question 6.

import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { postPrice, openPool } from "../src/loans.js";
import { readPriceFeed, unit } from "../src/lending.js";
import { preprod, submitAndRecord, PREPROD_TEST_VALUES } from "../src/preprod-loans.js";

const [cmd, ...args] = process.argv.slice(2);
const submit = args.includes("--submit");
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const has = (flag: string) => args.includes(flag);
const tusd = (n: string) => BigInt(Math.round(Number(n) * 1e6));

const p = await preprod();
const { l } = p;

async function price(): Promise<bigint> {
  if (has("--usd")) return tusd(value("--usd") ?? "");
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd", { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}; pass --usd P instead`);
  const usd = (await res.json()).cardano.usd as number;
  console.log(`ADA/USD       : ${usd} (CoinGecko, ${new Date().toISOString()})`);
  return BigInt(Math.round(usd * 1e6));
}

console.log(`lending script: ${validatorToScriptHash(l.lending)}`);
console.log(`pool script   : ${validatorToScriptHash(l.pool)}  ${l.poolAddress}`);
console.log(`stablecoin    : ${unit(l.cfg.stable)}`);
console.log(`test values   : price good for ${l.cfg.maxAgeMs / 60_000} min, max LTV ${l.cfg.maxLtvBps / 100}%, ${l.cfg.rateBps / 100}% a year`);

if (cmd === "status") {
  const { poolUtxo, oracle } = await p.state();
  console.log(`pool          : ${poolUtxo ? `${Number(poolUtxo.assets[unit(l.cfg.stable)] ?? 0n) / 1e6} tUSD at ${poolUtxo.txHash}#${poolUtxo.outputIndex}` : "not open"}`);
  if (oracle) {
    const f = readPriceFeed(oracle.datum!);
    console.log(`oracle        : ${Number(f.price) / 1e6} tUSD per ADA, posted ${new Date(Number(f.postedAt)).toISOString()}`);
  }
  process.exit(0);
}

let tx;
if (cmd === "open") {
  if (p.isOpen) throw new Error("the pool is already recorded in deployments; use `price` or `status`");
  const supply = tusd(value("--supply") ?? "5000");
  const spare = tusd(value("--spare") ?? "100");
  const px = await price();
  tx = openPool(p.lucid, p.ownerKey, p.wallet.address, l, supply, spare, px, Date.now());
  console.log(`open          : pool with ${Number(supply) / 1e6} tUSD, ${Number(spare) / 1e6} tUSD to the wallet, price ${Number(px) / 1e6}`);
} else if (cmd === "price") {
  const { oracle } = await p.state();
  if (!oracle) throw new Error("no oracle UTxO; run `open` first");
  const px = await price();
  tx = postPrice(p.lucid, oracle, l, px, Date.now());
  console.log(`price         : ${Number(px) / 1e6} tUSD per ADA`);
} else {
  console.error("usage: npm run loans -- open|price|status [--usd P] [--submit]");
  process.exit(1);
}

const built = await tx.complete();
console.log(`tx            : built, fee ${Number(built.toTransaction().body().fee()) / 1e6} tADA`);
if (!submit) {
  console.log("dry run       : not submitted. Rerun with --submit.");
  process.exit(0);
}
if (cmd === "open") {
  p.dep.loans = {
    note: "Preprod test values, not proposals (open question 6). tUSD, POOL and ORACLE are minted under a native policy signed by the test wallet.",
    config: { ...l.cfg, ...PREPROD_TEST_VALUES },
    lendingHash: validatorToScriptHash(l.lending),
    poolHash: validatorToScriptHash(l.pool),
    poolAddress: l.poolAddress,
    log: [],
  };
}
await submitAndRecord(p, tx, { action: cmd });
