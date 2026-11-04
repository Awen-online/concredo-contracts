// Create a vault through the creation mint (open question 2), or adopt an
// existing vault into it.
//
//   npm run vault:mint -- drep1... [--pool pool1...]... [--grief] [--submit]
//
// The vault is identified by its DRep and approved pools (repeat --pool; the
// first one is delegated to). The transaction delegates the vault to its own
// DRep and mints one token named by the vault's script hash. The policy rebuilds
// that hash on chain, so the token proves the vault runs the genuine code.
//
//   not registered : register and delegate in one certificate, plus the mint
//   registered     : delegate again (the vault script runs), plus the mint.
//                    This adopts vaults created before the mint existed, and
//                    recovers a vault someone registered first.
//
// --grief first registers a fresh vault through the legacy certificate (no
// script runs, as in Pondora's POND2-001), then shows the normal path fails
// and the recovery path works. Before anything is sent, it builds two mints
// the policy must refuse: one with no certificate, one named for another vault.
// Without --submit nothing is sent.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Data, drepIDToCredential, Lucid, type DRep } from "@lucid-evolution/lucid";
import { KEYS_DIR, REPO_ROOT, loadConfig } from "../src/config.js";
import { providerFromConfig } from "../src/provider.js";
import { governanceFromConfig } from "../src/governance.js";
import { bucketIdentity, loadBlueprint } from "../src/blueprint.js";
import { createVaultRedeemer, vaultMint } from "../src/vault-mint.js";
import { koios } from "../src/koios.js";

const args = process.argv.slice(2);
const submit = args.includes("--submit");
const grief = args.includes("--grief");
const drepId = args.find((a) => a.startsWith("drep"));
const poolIds = args.flatMap((a, i) => (args[i - 1] === "--pool" ? [a] : []));
if (!drepId) {
  console.error("usage: npm run vault:mint -- drep1... [--pool pool1...]... [--grief] [--submit]");
  process.exit(1);
}

const cfg = loadConfig();
const net = cfg.network.toLowerCase();
const k = koios(cfg);
const walletFile = path.join(KEYS_DIR, `${net}-wallet.json`);
if (!existsSync(walletFile)) {
  console.error(`No wallet at ${walletFile}. Run \`npm run wallet:new\`, then fund it from the faucet.`);
  process.exit(1);
}
const wallet = JSON.parse(readFileSync(walletFile, "utf8")) as { mnemonic: string; address: string };

if (!(await governanceFromConfig(cfg).drepStatus(drepId)).registered) {
  console.error(`DRep ${drepId} is not registered on ${cfg.network}.`);
  process.exit(1);
}

const bp = loadBlueprint();
const approvedPools = await Promise.all(poolIds.map((p) => k.poolHexId(p)));
const params = { drepId, approvedPoolKeyHashes: approvedPools };
const vault = bucketIdentity(params, cfg.network);
const mint = vaultMint(bp);
const unit = mint.policyId + vault.scriptHash;
const redeemer = createVaultRedeemer(params);
const own: DRep = drepIDToCredential(drepId);
console.log(`network      : ${cfg.network}`);
console.log(`drep         : ${drepId}`);
console.log(`pools        : ${poolIds.join(", ") || "none"}`);
console.log(`vault script : ${vault.scriptHash}`);
console.log(`stake address: ${vault.rewardAddress}`);
console.log(`mint policy  : ${mint.policyId}`);

const lucid = await Lucid(providerFromConfig(cfg), cfg.network);
lucid.selectWallet.fromSeed(wallet.mnemonic);

const refused = (p: Promise<unknown>) => p.then(() => false, () => true);

// Policy refusals, built and evaluated only.
const other = bucketIdentity({ drepId, approvedPoolKeyHashes: [...approvedPools, "00".repeat(28)] }, cfg.network);
const noCert = await refused(
  lucid.newTx().mintAssets({ [unit]: 1n }, redeemer).attach.MintingPolicy(mint.script).complete(),
);
const wrongName = await refused(
  lucid.newTx()
    .delegate.VoteToDRep(vault.rewardAddress, own, Data.void())
    .attach.CertificateValidator(vault.script)
    .mintAssets({ [mint.policyId + other.scriptHash]: 1n }, redeemer)
    .attach.MintingPolicy(mint.script)
    .complete(),
);
console.log(`check        : mint with no certificate ${noCert ? "refused, as designed" : "ACCEPTED"}`);
console.log(`check        : token named for another vault ${wrongName ? "refused, as designed" : "ACCEPTED"}`);
if (!noCert || !wrongName) process.exit(1);

let acct = await k.accountInfo(vault.rewardAddress);
const record: Record<string, unknown> = {};

if (grief) {
  if (acct?.status === "registered") {
    console.error("--grief needs a vault that is not registered yet. Pick other pools.");
    process.exit(1);
  }
  const legacy = await lucid.newTx().register.Stake(vault.rewardAddress).complete();
  console.log(`grief        : legacy registration built (no script runs), fee ${Number(legacy.toTransaction().body().fee()) / 1e6} tADA`);
  if (!submit) {
    console.log("dry run      : not submitted. Rerun with --submit.");
    process.exit(0);
  }
  const g = await (await legacy.sign.withWallet().complete()).submit();
  console.log(`grief tx     : ${g}`);
  acct = await k.waitFor(vault.rewardAddress, (a) => a?.status === "registered");
  console.log(`on chain     : ${acct?.status}, DRep ${acct?.delegated_drep ?? "none"} (registered without the vault script running)`);
  record.griefTxHash = g;

  // The normal path must now fail: the credential is already registered.
  const normal = await refused(
    (async () => {
      const tx = await lucid.newTx()
        .registerAndDelegate.ToDRep(vault.rewardAddress, own, Data.void())
        .attach.CertificateValidator(vault.script)
        .mintAssets({ [unit]: 1n }, redeemer)
        .attach.MintingPolicy(mint.script)
        .complete();
      return (await tx.sign.withWallet().complete()).submit();
    })(),
  );
  console.log(`check        : normal create after griefing ${normal ? "rejected by the ledger, as expected" : "ACCEPTED"}`);
  if (!normal) process.exit(1);
}

const registered = acct?.status === "registered";
let b = registered
  ? poolIds.length
    ? lucid.newTx().delegate.VoteToPoolAndDRep(vault.rewardAddress, poolIds[0], own, Data.void())
    : lucid.newTx().delegate.VoteToDRep(vault.rewardAddress, own, Data.void())
  : poolIds.length
    ? lucid.newTx().registerAndDelegate.ToPoolAndDRep(vault.rewardAddress, poolIds[0], own, Data.void())
    : lucid.newTx().registerAndDelegate.ToDRep(vault.rewardAddress, own, Data.void());
b = b.attach.CertificateValidator(vault.script).mintAssets({ [unit]: 1n }, redeemer).attach.MintingPolicy(mint.script);
const tx = await b.complete();
console.log(`path         : ${registered ? "already registered: delegate plus mint" : "register and delegate plus mint"}`);
console.log(`tx           : built and evaluated, fee ${Number(tx.toTransaction().body().fee()) / 1e6} tADA, ${tx.toCBOR().length / 2} bytes`);
if (!submit) {
  console.log("dry run      : not submitted. Rerun with --submit.");
  process.exit(0);
}

const txHash = await (await tx.sign.withWallet().complete()).submit();
console.log(`submitted    : ${txHash}`);
const ok = await k.txConfirmed(txHash);
const after = await k.accountInfo(vault.rewardAddress);
console.log(`confirmed    : ${ok ? "yes" : "not yet"} https://preprod.cardanoscan.io/transaction/${txHash}`);
console.log(`on chain     : ${after?.status}, DRep ${after?.delegated_drep ?? "none"}, pool ${after?.delegated_pool ?? "none"}`);

// Record: attach the mint to an existing vault entry, or add the vault.
const depFile = path.join(REPO_ROOT, "deployments", `${net}.json`);
const dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : { vaults: [] };
dep.vaultMint = {
  policyId: mint.policyId,
  compiler: `${bp.preamble.compiler?.name} ${bp.preamble.compiler?.version}`,
  plutus: bp.preamble.plutusVersion,
};
let v = dep.vaults.find((x: { scriptHash: string }) => x.scriptHash === vault.scriptHash);
if (!v) {
  v = { drepId, approvedPools, pool: poolIds[0], scriptHash: vault.scriptHash, stakeAddress: vault.rewardAddress,
    compiler: dep.vaultMint.compiler, plutus: bp.preamble.plutusVersion, txHash, createdAt: new Date().toISOString() };
  dep.vaults.push(v);
}
v.mint = { unit, txHash, path: registered ? "delegate" : "register-and-delegate", ...record, mintedAt: new Date().toISOString() };
writeFileSync(depFile, JSON.stringify(dep, null, 2) + "\n");
console.log(`recorded     : ${path.relative(REPO_ROOT, depFile)}`);
