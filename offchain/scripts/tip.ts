// Read the chain tip and (optionally) an address's UTxOs through the configured provider.
//
//   npm run tip                      tip only (plus your keys/ wallet's UTxOs if one exists)
//   npm run tip -- addr_test1...     tip and that address's UTxOs
//
// Works with no API key: the default provider is Koios public tier.

import { existsSync, readFileSync } from "node:fs";
import { Lucid } from "@lucid-evolution/lucid";
import path from "node:path";
import { KEYS_DIR, loadConfig } from "../src/config.js";
import { providerFromConfig } from "../src/provider.js";

const cfg = loadConfig();
const provider = providerFromConfig(cfg);

let address = process.argv[2];
const walletFile = path.join(KEYS_DIR, `${cfg.network.toLowerCase()}-wallet.json`);
if (!address && existsSync(walletFile)) {
  address = (JSON.parse(readFileSync(walletFile, "utf8")) as { address: string }).address;
}

const tip = await provider.getTip();
console.log(`network : ${cfg.network}`);
console.log(`provider: ${provider.name}`);
console.log(`tip     : slot ${tip.slot}, block ${tip.height ?? "?"}, epoch ${tip.epoch ?? "?"}, ${tip.hash}`);
if (tip.time) console.log(`time    : ${new Date(tip.time * 1000).toISOString()}`);

// Initialising Lucid fetches protocol parameters through the same provider:
// proof that the tx builder is ready to build against this network.
await Lucid(provider, cfg.network);
const pp = await provider.getProtocolParameters();
console.log(`params  : keyDeposit ${pp.keyDeposit}, drepDeposit ${pp.drepDeposit}, maxTxSize ${pp.maxTxSize}, Lucid ready`);

if (address) {
  const utxos = await provider.getUtxos(address);
  const lovelace = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  console.log(`address : ${address}`);
  console.log(`utxos   : ${utxos.length}, total ${Number(lovelace) / 1e6} tADA`);
  for (const u of utxos.slice(0, 10)) {
    const tokens = Object.keys(u.assets).filter((k) => k !== "lovelace").length;
    console.log(`  ${u.txHash}#${u.outputIndex}  ${Number(u.assets.lovelace ?? 0n) / 1e6} tADA` +
      (tokens ? ` + ${tokens} token(s)` : "") + (u.datum ? " [inline datum]" : "") + (u.scriptRef ? " [ref script]" : ""));
  }
  if (utxos.length > 10) console.log(`  ... ${utxos.length - 10} more`);
}
