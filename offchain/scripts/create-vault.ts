// Step 1 on preprod: create one DRep vault by registering its stake credential
// and delegating its vote to that DRep, in one transaction (open question 1).
//
//   npm run vault:create -- drep1...            dry run: build, evaluate, print, do not submit
//   npm run vault:create -- drep1... --submit   build, sign with keys/preprod-wallet.json, submit, wait
//   npm run vault:create -- drep1... --pool pool1... --stake 1000 --submit
//       also approve and delegate to that stake pool, and send 1000 tADA to an
//       address staked by the vault, so staking rewards can be observed
//
// Before submitting, it also builds a transaction that delegates the same vault
// to Always No Confidence and checks that the script refuses it: the vault's
// one rule, shown against live preprod parameters.
//
// Without --pool the approved pool list is empty and the vault earns no staking
// rewards. With --pool, the pool joins the script parameters (a new hash), and
// --stake sends ADA to an address whose stake part is the vault. TEST SHORTCUT:
// that address's payment part is the wallet key, not a deposit validator (step 2),
// so the ADA stays spendable by the wallet. The withdraw handler still refuses
// everything, so rewards accrue in the vault's reward account and stay there.
// Registration is not yet guarded by a creation mint (open question 2), so this
// is a test deployment, never a pattern for mainnet.
//
// The wallet pays the 2 tADA stake key deposit plus the fee. On success it
// appends the vault to deployments/preprod.json (public data: no keys).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { credentialToAddress, Data, drepIDToCredential, getAddressDetails, Lucid, type DRep } from "@lucid-evolution/lucid";
import { KEYS_DIR, REPO_ROOT, loadConfig } from "../src/config.js";
import { providerFromConfig } from "../src/provider.js";
import { governanceFromConfig } from "../src/governance.js";
import { bucketIdentity, loadBlueprint } from "../src/blueprint.js";

const args = process.argv.slice(2);
const submit = args.includes("--submit");
const drepId = args.find((a) => a.startsWith("drep"));
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const poolId = flag("--pool");
const stakeAda = flag("--stake") ? BigInt(Math.round(Number(flag("--stake")) * 1e6)) : 0n;
if (stakeAda > 0n && !poolId) {
  console.error("--stake needs --pool: without a pool there are no staking rewards to observe.");
  process.exit(1);
}
if (!drepId) {
  console.error("usage: npm run vault:create -- drep1... [--submit]");
  process.exit(1);
}

const cfg = loadConfig();
const net = cfg.network.toLowerCase();
const walletFile = path.join(KEYS_DIR, `${net}-wallet.json`);
if (!existsSync(walletFile)) {
  console.error(`No wallet at ${walletFile}. Run \`npm run wallet:new\`, then fund it from the faucet.`);
  process.exit(1);
}
const wallet = JSON.parse(readFileSync(walletFile, "utf8")) as { mnemonic: string; address: string };

// 1. The DRep must be registered on this network, or the ledger rejects the delegation.
const gov = governanceFromConfig(cfg);
const status = await gov.drepStatus(drepId);
if (!status.registered) {
  console.error(`DRep ${drepId} is not registered on ${cfg.network}. Pick one from \`npm run drep\` or a preprod explorer.`);
  process.exit(1);
}

// 2. The vault's identity: the DRep is a script parameter, so it is in the hash.
const bp = loadBlueprint();
const poolHex = poolId ? await poolHexId(poolId) : undefined;
const approvedPools = poolHex ? [poolHex] : [];
const vault = bucketIdentity({ drepId, approvedPoolKeyHashes: approvedPools }, cfg.network);
console.log(`network      : ${cfg.network}`);
console.log(`drep         : ${drepId}${status.active === false ? " (registered, inactive)" : ""}`);
console.log(`compiler     : ${bp.preamble.compiler?.name} ${bp.preamble.compiler?.version}, ${bp.preamble.plutusVersion}`);
console.log(`script hash  : ${vault.scriptHash}`);
console.log(`stake address: ${vault.rewardAddress}`);
if (poolId) console.log(`pool         : ${poolId} (${poolHex})`);

// 3. Stop if this vault already exists (same DRep, same blueprint, same hash).
const acct = await accountInfo(vault.rewardAddress);
if (acct?.status === "registered") {
  console.log(`already registered, delegated to ${acct.delegated_drep ?? "no DRep"}. Nothing to do.`);
  process.exit(0);
}

const provider = providerFromConfig(cfg);
const lucid = await Lucid(provider, cfg.network);
lucid.selectWallet.fromSeed(wallet.mnemonic);
const balance = (await lucid.wallet().getUtxos()).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
console.log(`wallet       : ${wallet.address} (${Number(balance) / 1e6} tADA)`);
if (balance < 5_000_000n + stakeAda) {
  console.error("Wallet needs at least 5 tADA (2 deposit plus fee and change). Fund it from the faucet.");
  process.exit(1);
}

// 4. Negative check: delegating the vault to any other target must fail in the script.
const refused = await lucid
  .newTx()
  .registerAndDelegate.ToDRep(vault.rewardAddress, { __typename: "AlwaysNoConfidence" }, Data.void())
  .attach.CertificateValidator(vault.script)
  .complete()
  .then(() => false, () => true);
if (!refused) {
  console.error("FAILED: the script accepted delegation to Always No Confidence. Do not submit.");
  process.exit(1);
}
console.log("check        : delegation to Always No Confidence refused by the script, as designed");
if (poolId) {
  const otherPool = await anotherPool(poolId);
  const poolRefused = await lucid
    .newTx()
    .registerAndDelegate.ToPoolAndDRep(vault.rewardAddress, otherPool, drepIDToCredential(drepId), Data.void())
    .attach.CertificateValidator(vault.script)
    .complete()
    .then(() => false, () => true);
  if (!poolRefused) {
    console.error(`FAILED: the script accepted unapproved pool ${otherPool}. Do not submit.`);
    process.exit(1);
  }
  console.log(`check        : unapproved pool ${otherPool.slice(0, 16)}... refused by the script, as designed`);
}

// 5. The real transaction: register and delegate to the vault's own DRep.
const own: DRep = drepIDToCredential(drepId);
let builder = poolId
  ? lucid.newTx().registerAndDelegate.ToPoolAndDRep(vault.rewardAddress, poolId, own, Data.void())
  : lucid.newTx().registerAndDelegate.ToDRep(vault.rewardAddress, own, Data.void());
builder = builder.attach.CertificateValidator(vault.script);
let stakedAddress: string | undefined;
if (stakeAda > 0n) {
  const payment = getAddressDetails(wallet.address).paymentCredential!;
  stakedAddress = credentialToAddress(cfg.network, payment, { type: "Script", hash: vault.scriptHash });
  builder = builder.pay.ToAddress(stakedAddress, { lovelace: stakeAda });
  console.log(`staked addr  : ${stakedAddress} (${Number(stakeAda) / 1e6} tADA)`);
}
const tx = await builder.complete();
const fee = tx.toTransaction().body().fee();
console.log(`tx           : built and evaluated, fee ${Number(fee) / 1e6} tADA, ${tx.toCBOR().length / 2} bytes`);

if (!submit) {
  console.log("dry run      : not submitted. Rerun with --submit to send it.");
  process.exit(0);
}

const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
console.log(`submitted    : ${txHash}`);
// Lucid's awaitTx can throw a parse error on Koios responses after a good
// submit, so confirmation is read from the vault's own account state instead.
let after = await accountInfo(vault.rewardAddress);
for (let i = 0; i < 30 && after?.status !== "registered"; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  after = await accountInfo(vault.rewardAddress);
}
console.log(`confirmed    : https://preprod.cardanoscan.io/transaction/${txHash}`);

console.log(`on chain     : ${after?.status ?? "not yet indexed"}, DRep ${after?.delegated_drep ?? "(indexer catching up)"}, pool ${after?.delegated_pool ?? "none"}`);

// 6. Record the deployment so anyone can rebuild the hash and check it.
const depDir = path.join(REPO_ROOT, "deployments");
const depFile = path.join(depDir, `${net}.json`);
mkdirSync(depDir, { recursive: true });
const record = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : { vaults: [] };
record.vaults.push({
  drepId,
  approvedPools,
  pool: poolId,
  stakedAddress,
  stakedLovelace: stakeAda.toString(),
  scriptHash: vault.scriptHash,
  stakeAddress: vault.rewardAddress,
  compiler: `${bp.preamble.compiler?.name} ${bp.preamble.compiler?.version}`,
  plutus: bp.preamble.plutusVersion,
  txHash,
  createdAt: new Date().toISOString(),
});
writeFileSync(depFile, JSON.stringify(record, null, 2) + "\n");
console.log(`recorded     : ${path.relative(REPO_ROOT, depFile)}`);

/** Koios account_info: registration status and current DRep of a stake address. */
async function koiosPost(endpoint: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.koios.token) headers.authorization = `Bearer ${cfg.koios.token}`;
  const res = await fetch(`${cfg.koios.url}/${endpoint}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`POST ${cfg.koios.url}/${endpoint} -> HTTP ${res.status}`);
  return res.json();
}

/** The pool's key hash in hex, which is what the script parameter holds. */
async function poolHexId(bech32: string): Promise<string> {
  const [p] = (await koiosPost("pool_info", { _pool_bech32_ids: [bech32] })) as Array<{ pool_id_hex: string; pool_status: string }>;
  if (!p || p.pool_status !== "registered") throw new Error(`pool ${bech32} is not registered on ${cfg.network}`);
  return p.pool_id_hex;
}

/** Any other registered pool, for the refusal check. */
async function anotherPool(exclude: string): Promise<string> {
  const res = await fetch(`${cfg.koios.url}/pool_list?pool_status=eq.registered&select=pool_id_bech32&limit=5`, { signal: AbortSignal.timeout(20_000) });
  const rows = (await res.json()) as Array<{ pool_id_bech32: string }>;
  const other = rows.find((r) => r.pool_id_bech32 !== exclude);
  if (!other) throw new Error("no other registered pool found for the refusal check");
  return other.pool_id_bech32;
}

async function accountInfo(stakeAddress: string): Promise<{ status: string; delegated_drep?: string; delegated_pool?: string } | undefined> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.koios.token) headers.authorization = `Bearer ${cfg.koios.token}`;
  const res = await fetch(`${cfg.koios.url}/account_info`, {
    method: "POST",
    headers,
    body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`POST ${cfg.koios.url}/account_info -> HTTP ${res.status}`);
  const [row] = (await res.json()) as Array<{ status: string; delegated_drep?: string; delegated_pool?: string }>;
  return row;
}
