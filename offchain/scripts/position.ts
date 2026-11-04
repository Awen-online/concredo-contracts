// Collateral positions and loans through the lending validator v1 on preprod.
//
//   npm run position -- deposit  drep1... [--pool pool1...]... --ada N [--from-shortcut] [--submit]
//   npm run position -- adjust   drep1... [--pool pool1...]... --ada N   [--submit]   (N = new total)
//   npm run position -- move     drep1... [--pool pool1...]... --to drep1... [--to-pool pool1...]... [--submit]
//   npm run position -- withdraw drep1... [--pool pool1...]...           [--submit]
//   npm run position -- borrow   drep1... [--pool pool1...]... --usd N   [--submit]
//   npm run position -- repay    drep1... [--pool pool1...]... --usd N|all [--submit]
//   npm run position -- migrate  drep1... [--pool pool1...]...           [--submit]
//   npm run position -- list
//
// A position lives at the vault's full address: the lending script as payment
// part, the vault as stake part, so the ADA is staked by and votes with that
// vault. The owner is the test wallet's payment key.
//
// --from-shortcut moves the ADA that create-vault --stake left at the test
// shortcut address (wallet payment key, vault stake part) into a real position.
// migrate moves a v0 position (deployments/scripts/lending-v0.json) to v1 at the
// same vault. Neither changes the stake credential, so staking rewards keep
// their timeline.
//
// Before an adjust, move or borrow is sent, a variant that must fail is built
// first (re-pointed stake part, mismatched DRep, loan over the LTV) and must be
// refused by the script.

import { credentialToAddress, getAddressDetails, validatorToScriptHash, type UTxO } from "@lucid-evolution/lucid";
import { bucketIdentity, type BucketParams } from "../src/blueprint.js";
import { Action, maxLoan, owed, positionAddress, positionDatum, readPosition, readPriceFeed } from "../src/lending.js";
import { borrow, repay } from "../src/loans.js";
import { preprod } from "../src/preprod-loans.js";

const [cmd, ...args] = process.argv.slice(2);
const submit = args.includes("--submit");
const values = (flag: string) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
const drepId = args.find((a, i) => a.startsWith("drep") && args[i - 1] !== "--to");
const ada = values("--ada")[0];
const usd = values("--usd")[0];

const p = await preprod();
const { l, lucid, wallet, ownerKey, cfg } = p;
const script = l.lending;

async function vaultParams(drep: string, pools: string[]): Promise<BucketParams> {
  return { drepId: drep, approvedPoolKeyHashes: await Promise.all(pools.map((x) => p.k.poolHexId(x))) };
}

async function ownPosition(at: string): Promise<UTxO> {
  const [u] = (await lucid.utxosAt(at)).filter((x) => x.datum && readPosition(x.datum).owner === ownerKey);
  if (!u) throw new Error(`no position of this wallet at ${at}`);
  return u;
}

const refused = (pr: Promise<unknown>) => pr.then(() => false, (e) => /Spend/.test(String(e)));
const v0Address = (v: BucketParams) => positionAddress(cfg.network, v, p.lendingV0);

if (cmd === "list") {
  for (const v of p.dep.vaults as Array<{ drepId: string; approvedPools: string[]; scriptHash: string }>) {
    const vault = { drepId: v.drepId, approvedPoolKeyHashes: v.approvedPools };
    for (const [tag, addr] of [["v1", positionAddress(cfg.network, vault, script)], ["v0", v0Address(vault)]]) {
      const us = await lucid.utxosAt(addr);
      if (!us.length && tag === "v0") continue;
      const total = us.reduce((s, u) => s + u.assets.lovelace, 0n);
      const debt = us.reduce((s, u) => s + (tag === "v1" && u.datum ? readPosition(u.datum).debt : 0n), 0n);
      console.log(`${tag} vault ${v.scriptHash.slice(0, 12)}...  ${us.length} position(s), ${Number(total) / 1e6} tADA${debt ? `, loan ${Number(debt) / 1e6} tUSD` : ""}  ${addr}`);
    }
  }
  process.exit(0);
}

if (!drepId || !["deposit", "adjust", "move", "withdraw", "borrow", "repay", "migrate"].includes(cmd)) {
  console.error("usage: npm run position -- deposit|adjust|move|withdraw|borrow|repay|migrate drep1... [--pool ...] [--ada N] [--usd N|all] [--to drep1...] [--submit]");
  process.exit(1);
}

const vault = await vaultParams(drepId, values("--pool"));
const here = positionAddress(cfg.network, vault, script);
console.log(`lending script: ${validatorToScriptHash(script)}`);
console.log(`vault         : ${bucketIdentity(vault, cfg.network).scriptHash}`);
console.log(`position addr : ${here}`);

let builder;
let extra: Record<string, unknown> = {};
if (cmd === "deposit") {
  let lovelace = ada ? BigInt(Math.round(Number(ada) * 1e6)) : 0n;
  builder = lucid.newTx();
  if (args.includes("--from-shortcut")) {
    const payment = getAddressDetails(wallet.address).paymentCredential!;
    const shortcut = credentialToAddress(cfg.network, payment, { type: "Script", hash: bucketIdentity(vault, cfg.network).scriptHash });
    const us = await lucid.utxosAt(shortcut);
    if (!us.length) throw new Error(`nothing at the shortcut address ${shortcut}`);
    const sum = us.reduce((s, u) => s + u.assets.lovelace, 0n);
    console.log(`from shortcut : ${us.length} UTxO(s), ${Number(sum) / 1e6} tADA at ${shortcut}`);
    builder = builder.collectFrom(us);
    if (!lovelace) lovelace = sum;
  }
  if (!lovelace) throw new Error("--ada N is required");
  builder = builder.pay.ToContract(here, { kind: "inline", value: positionDatum(ownerKey, vault) }, { lovelace });
  console.log(`deposit       : ${Number(lovelace) / 1e6} tADA`);
} else if (cmd === "migrate") {
  const u = await ownPosition(v0Address(vault));
  console.log(`v0 position   : ${u.txHash}#${u.outputIndex}, ${Number(u.assets.lovelace) / 1e6} tADA`);
  builder = lucid.newTx().collectFrom([u], Action.withdraw()).attach.SpendingValidator(p.lendingV0).addSigner(wallet.address)
    .pay.ToContract(here, { kind: "inline", value: positionDatum(ownerKey, vault) }, { lovelace: u.assets.lovelace });
  console.log(`migrate       : to v1 at the same vault`);
} else {
  const u = await ownPosition(here);
  const pos = readPosition(u.datum!);
  console.log(`position      : ${u.txHash}#${u.outputIndex}, ${Number(u.assets.lovelace) / 1e6} tADA, loan ${Number(pos.debt) / 1e6} tUSD`);
  const datum = (v: BucketParams) => positionDatum(ownerKey, v, pos.debt, pos.since);
  if (cmd === "borrow" || cmd === "repay") {
    if (!usd) throw new Error("--usd N is required");
    const { poolUtxo, oracle } = await p.state();
    if (!poolUtxo || !oracle) throw new Error("pool not open; run `npm run loans -- open` first");
    const feed = readPriceFeed(oracle.datum!);
    console.log(`oracle        : ${Number(feed.price) / 1e6} tUSD per ADA, posted ${new Date(Number(feed.postedAt)).toISOString()}`);
    const step = { position: u, vault, owner: wallet.address, ownerKeyHash: ownerKey, poolUtxo, oracle, now: Date.now() };
    if (cmd === "borrow") {
      const amount = BigInt(Math.round(Number(usd) * 1e6));
      const room = maxLoan(l.cfg, u.assets.lovelace, feed.price) - owed(l.cfg, pos.debt, pos.since, BigInt(Date.now()));
      const over = await refused(borrow(lucid, l, { ...step, amount: room + 1_000_000n }).complete());
      console.log(`check         : borrowing ${Number(room + 1_000_000n) / 1e6} tUSD (1 over the LTV) ${over ? "refused by the script, as designed" : "NOT REFUSED"}`);
      if (!over) process.exit(1);
      builder = borrow(lucid, l, { ...step, amount });
      console.log(`borrow        : ${Number(amount) / 1e6} tUSD (room was ${Number(room) / 1e6})`);
      extra = { tUSD: Number(amount) / 1e6 };
    } else {
      const r = repay(lucid, l, { ...step, amount: usd === "all" ? "all" : BigInt(Math.round(Number(usd) * 1e6)) });
      builder = r.tx;
      console.log(`repay         : ${Number(r.amount) / 1e6} tUSD`);
      extra = { tUSD: Number(r.amount) / 1e6 };
    }
  } else {
    const elsewhere = positionAddress(cfg.network, { drepId, approvedPoolKeyHashes: [...vault.approvedPoolKeyHashes, "00".repeat(28)] }, script);
    if (cmd === "withdraw") {
      builder = lucid.newTx().collectFrom([u], Action.withdraw());
    } else if (cmd === "adjust") {
      const lovelace = BigInt(Math.round(Number(ada) * 1e6));
      const repoint = await refused(
        lucid.newTx().collectFrom([u], Action.adjust())
          .pay.ToContract(elsewhere, { kind: "inline", value: datum(vault) }, { lovelace })
          .attach.SpendingValidator(script).addSigner(wallet.address).complete(),
      );
      console.log(`check         : adjust re-pointed to another stake part ${repoint ? "refused by the script, as designed" : "NOT REFUSED"}`);
      if (!repoint) process.exit(1);
      builder = lucid.newTx().collectFrom([u], Action.adjust())
        .pay.ToContract(here, { kind: "inline", value: datum(vault) }, { lovelace });
      console.log(`adjust        : to ${Number(lovelace) / 1e6} tADA`);
    } else {
      const to = await vaultParams(values("--to")[0], values("--to-pool"));
      const there = positionAddress(cfg.network, to, script);
      const mismatch = await refused(
        lucid.newTx().collectFrom([u], Action.move(to))
          .pay.ToContract(here, { kind: "inline", value: datum(to) }, { lovelace: u.assets.lovelace })
          .attach.SpendingValidator(script).addSigner(wallet.address).complete(),
      );
      console.log(`check         : move whose address does not match the new DRep ${mismatch ? "refused by the script, as designed" : "NOT REFUSED"}`);
      if (!mismatch) process.exit(1);
      builder = lucid.newTx().collectFrom([u], Action.move(to))
        .pay.ToContract(there, { kind: "inline", value: datum(to) }, { lovelace: u.assets.lovelace });
      console.log(`move to       : vault ${bucketIdentity(to, cfg.network).scriptHash} (${to.drepId})`);
    }
    builder = builder.attach.SpendingValidator(script).addSigner(wallet.address);
  }
}

const tx = await builder.complete();
console.log(`tx            : built and evaluated, fee ${Number(tx.toTransaction().body().fee()) / 1e6} tADA`);
if (!submit) {
  console.log("dry run       : not submitted. Rerun with --submit.");
  process.exit(0);
}
const txHash = await (await tx.sign.withWallet().complete()).submit();
const ok = await p.k.txConfirmed(txHash);
console.log(`confirmed     : ${ok ? "yes" : "not yet"} https://preprod.cardanoscan.io/transaction/${txHash}`);
p.dep.lending.log.push({ action: cmd, script: validatorToScriptHash(script), vault: bucketIdentity(vault, cfg.network).scriptHash, ...extra, txHash, at: new Date().toISOString() });
p.save();
console.log(`recorded      : deployments/${p.net}.json`);

