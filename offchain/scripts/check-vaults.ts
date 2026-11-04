// Cross-check every vault in deployments/<network>.json against live chain state.
//
//   npm run vault:check
//
// For each vault: confirms it is registered and delegated to its own DRep, then
// builds (never submits) a re-delegation to every other vault's DRep and to
// Always No Confidence, and expects the script to refuse each one. A re-delegation
// to its own DRep must still be accepted. Builds are evaluated against live
// preprod parameters; nothing is signed or sent.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Data, drepIDToCredential, Lucid, type DRep } from "@lucid-evolution/lucid";
import { KEYS_DIR, REPO_ROOT, loadConfig } from "../src/config.js";
import { providerFromConfig } from "../src/provider.js";
import { bucketIdentity } from "../src/blueprint.js";

interface VaultRecord { drepId: string; approvedPools: string[]; scriptHash: string; stakeAddress: string }

const cfg = loadConfig();
const net = cfg.network.toLowerCase();
const depFile = path.join(REPO_ROOT, "deployments", `${net}.json`);
const vaults = (JSON.parse(readFileSync(depFile, "utf8")) as { vaults: VaultRecord[] }).vaults;
const walletFile = path.join(KEYS_DIR, `${net}-wallet.json`);
if (!existsSync(walletFile)) throw new Error(`No wallet at ${walletFile}; one is needed to pay the (unsent) fees.`);

const lucid = await Lucid(providerFromConfig(cfg), cfg.network);
lucid.selectWallet.fromSeed((JSON.parse(readFileSync(walletFile, "utf8")) as { mnemonic: string }).mnemonic);

let failures = 0;
const report = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`);
};

for (const v of vaults) {
  const id = bucketIdentity({ drepId: v.drepId, approvedPoolKeyHashes: v.approvedPools }, cfg.network);
  console.log(`\nvault ${v.scriptHash.slice(0, 12)}... (DRep ${v.drepId.slice(0, 16)}...)`);
  report(id.scriptHash === v.scriptHash, "script hash rebuilds from the blueprint and the DRep");

  const acct = await accountInfo(v.stakeAddress);
  report(acct?.status === "registered" && acct.delegated_drep === v.drepId,
    `on chain: ${acct?.status ?? "unknown"}, delegated to ${acct?.delegated_drep ?? "none"}`);

  const attempt = (target: DRep) =>
    lucid.newTx()
      .delegate.VoteToDRep(id.rewardAddress, target, Data.void())
      .attach.CertificateValidator(id.script)
      .complete()
      .then(() => true, () => false);

  report(await attempt(drepIDToCredential(v.drepId)), "re-delegation to its own DRep accepted");
  report(!(await attempt({ __typename: "AlwaysNoConfidence" })), "Always No Confidence refused");
  for (const other of vaults.filter((o) => o.drepId !== v.drepId)) {
    report(!(await attempt(drepIDToCredential(other.drepId))),
      `other vault's DRep ${other.drepId.slice(0, 16)}... refused`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

async function accountInfo(stakeAddress: string): Promise<{ status: string; delegated_drep?: string } | undefined> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.koios.token) headers.authorization = `Bearer ${cfg.koios.token}`;
  const res = await fetch(`${cfg.koios.url}/account_info`, {
    method: "POST",
    headers,
    body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`POST ${cfg.koios.url}/account_info -> HTTP ${res.status}`);
  const [row] = (await res.json()) as Array<{ status: string; delegated_drep?: string }>;
  return row;
}
