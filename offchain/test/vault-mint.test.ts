// Offline checks of the vault creation mint (open question 2), in Lucid
// Evolution's Emulator with phase-2 evaluation.
//
// The emulator runs the real compiled policy, so a successful mint means the
// on-chain rebuild of the vault hash (identity.ak) matched the real script hash.

import { describe, expect, it } from "vitest";
import {
  Data,
  Emulator,
  generateEmulatorAccount,
  Lucid,
  validatorToScriptHash,
  type Credential,
} from "@lucid-evolution/lucid";
import { bucketIdentity, bucketStakeScript } from "../src/blueprint.js";
import { bucketTemplate, createVaultRedeemer, rebuildFlat, vaultMint } from "../src/vault-mint.js";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "./bech32.js";

const drepA = bech32("drep", "aa".repeat(28));
const drepB = bech32("drep", "bb".repeat(28));
const own: Credential = { type: "Key", hash: "aa".repeat(28) };
const other: Credential = { type: "Key", hash: "bb".repeat(28) };

function header(n: number): string {
  if (n < 24) return (0x40 + n).toString(16);
  if (n < 256) return "58" + n.toString(16).padStart(2, "0");
  if (n < 65536) return "59" + n.toString(16).padStart(4, "0");
  return "5a" + n.toString(16).padStart(8, "0");
}

async function setup() {
  const user = generateEmulatorAccount({ lovelace: 200_000_000n });
  const emulator = new Emulator([user]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(user.seedPhrase);
  return { emulator, lucid };
}

describe("vault identity template", () => {
  it("rebuilds the script hash of any vault from its DRep and pools", () => {
    const t = bucketTemplate();
    const pools = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(2, "0").repeat(28));
    for (const p of [
      { drepId: drepA, approvedPoolKeyHashes: [] },
      { drepId: drepB, approvedPoolKeyHashes: pools.slice(0, 1) },
      { drepId: drepA, approvedPoolKeyHashes: pools }, // > 255 bytes of CBOR: two flat chunks
    ]) {
      const flat = rebuildFlat(t, p);
      const h = Buffer.from(blake2b(Buffer.from("03" + header(flat.length / 2) + flat, "hex"), { dkLen: 28 })).toString("hex");
      expect(h).toBe(validatorToScriptHash(bucketStakeScript(p)));
    }
  });
});

describe("vault creation mint", () => {
  const params = { drepId: drepA, approvedPoolKeyHashes: [] };

  it("mints with register-and-delegate to the vault's own DRep", async () => {
    const { lucid } = await setup();
    const vault = bucketIdentity(params, "Custom");
    const mint = vaultMint();
    const tx = await lucid
      .newTx()
      .registerAndDelegate.ToDRep(vault.rewardAddress, own, Data.void())
      .attach.CertificateValidator(vault.script)
      .mintAssets({ [mint.policyId + vault.scriptHash]: 1n }, createVaultRedeemer(params))
      .attach.MintingPolicy(mint.script)
      .complete();
    expect(await (await tx.sign.withWallet().complete()).submit()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a mint with no certificate", async () => {
    const { lucid } = await setup();
    const vault = bucketIdentity(params, "Custom");
    const mint = vaultMint();
    await expect(
      lucid.newTx()
        .mintAssets({ [mint.policyId + vault.scriptHash]: 1n }, createVaultRedeemer(params))
        .attach.MintingPolicy(mint.script)
        .complete(),
    ).rejects.toThrow();
  });

  it("refuses a token named for another vault", async () => {
    const { lucid } = await setup();
    const vault = bucketIdentity(params, "Custom");
    const otherVault = bucketIdentity({ drepId: drepB, approvedPoolKeyHashes: [] }, "Custom");
    const mint = vaultMint();
    await expect(
      lucid.newTx()
        .registerAndDelegate.ToDRep(vault.rewardAddress, own, Data.void())
        .attach.CertificateValidator(vault.script)
        .mintAssets({ [mint.policyId + otherVault.scriptHash]: 1n }, createVaultRedeemer(params))
        .attach.MintingPolicy(mint.script)
        .complete(),
    ).rejects.toThrow();
  });

  it("recovers a vault someone registered first through the legacy certificate", async () => {
    const { emulator, lucid } = await setup();
    const vault = bucketIdentity(params, "Custom");
    const mint = vaultMint();

    // The griefing step: legacy registration runs no script.
    const grief = await lucid.newTx().register.Stake(vault.rewardAddress).complete();
    await (await grief.sign.withWallet().complete()).submit();
    emulator.awaitBlock(1);

    // The normal create path now fails at the ledger: already registered.
    const normal = lucid
      .newTx()
      .registerAndDelegate.ToDRep(vault.rewardAddress, own, Data.void())
      .attach.CertificateValidator(vault.script)
      .mintAssets({ [mint.policyId + vault.scriptHash]: 1n }, createVaultRedeemer(params))
      .attach.MintingPolicy(mint.script)
      .complete()
      .then(async (tx) => (await tx.sign.withWallet().complete()).submit());
    await expect(normal).rejects.toThrow();

    // The recovery path: delegate (script runs) plus mint.
    const tx = await lucid
      .newTx()
      .delegate.VoteToDRep(vault.rewardAddress, own, Data.void())
      .attach.CertificateValidator(vault.script)
      .mintAssets({ [mint.policyId + vault.scriptHash]: 1n }, createVaultRedeemer(params))
      .attach.MintingPolicy(mint.script)
      .complete();
    expect(await (await tx.sign.withWallet().complete()).submit()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses the recovery path to another DRep (the vault script refuses it)", async () => {
    const { emulator, lucid } = await setup();
    const vault = bucketIdentity(params, "Custom");
    const mint = vaultMint();
    const grief = await lucid.newTx().register.Stake(vault.rewardAddress).complete();
    await (await grief.sign.withWallet().complete()).submit();
    emulator.awaitBlock(1);
    await expect(
      lucid.newTx()
        .delegate.VoteToDRep(vault.rewardAddress, other, Data.void())
        .attach.CertificateValidator(vault.script)
        .mintAssets({ [mint.policyId + vault.scriptHash]: 1n }, createVaultRedeemer(params))
        .attach.MintingPolicy(mint.script)
        .complete(),
    ).rejects.toThrow();
  });
});
