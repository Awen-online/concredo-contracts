// Offline end-to-end check of the bucket stake script's certificate branch,
// using Lucid Evolution's in-memory Emulator (phase-2 scripts are evaluated).
// This is the cheapest rehearsal of open question 1 (registration plus vote
// delegation at bucket creation) before the same flow runs on preprod.

import { describe, expect, it } from "vitest";
import {
  Data,
  Emulator,
  generateEmulatorAccount,
  Lucid,
  type Credential,
} from "@lucid-evolution/lucid";
import { bucketIdentity, bucketStakeScript } from "../src/blueprint.js";
import { bech32 } from "./bech32.js";

// Two syntactically valid CIP-105 key DRep ids derived from fixed hashes.
const drepA = bech32("drep", "aa".repeat(28));
const drepB = bech32("drep", "bb".repeat(28));
const credB: Credential = { type: "Key", hash: "bb".repeat(28) };

describe("bucket stake script", () => {
  it("binds the DRep into the script hash", () => {
    const a = bucketStakeScript({ drepId: drepA, approvedPoolKeyHashes: [] });
    const b = bucketStakeScript({ drepId: drepB, approvedPoolKeyHashes: [] });
    expect(a.script).not.toEqual(b.script);
  });

  it("registers and vote-delegates to its own DRep, refuses another", async () => {
    const user = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([user]);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(user.seedPhrase);

    const bucket = bucketIdentity({ drepId: drepA, approvedPoolKeyHashes: [] }, "Custom");

    // Wrong DRep: the script must refuse.
    await expect(
      lucid
        .newTx()
        .registerAndDelegate.ToDRep(bucket.rewardAddress, credB, Data.void())
        .attach.CertificateValidator(bucket.script)
        .complete(),
    ).rejects.toThrow(/failed script execution Publish/);

    // Own DRep, in the same transaction as registration (Conway combined cert).
    const own: Credential = { type: "Key", hash: "aa".repeat(28) };
    const tx = await lucid
      .newTx()
      .registerAndDelegate.ToDRep(bucket.rewardAddress, own, Data.void())
      .attach.CertificateValidator(bucket.script)
      .complete();
    const signed = await tx.sign.withWallet().complete();
    const hash = await signed.submit();
    emulator.awaitBlock(1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
