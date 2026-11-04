// Load validators from contracts/plutus.json (the Aiken blueprint) and apply parameters.
// The blueprint is the single source of truth for script bytes (settled design item 7).

import { readFileSync } from "node:fs";
import {
  applyParamsToScript,
  Constr,
  drepIDToCredential,
  validatorToRewardAddress,
  validatorToScriptHash,
  type Credential,
  type Data,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import { BLUEPRINT_PATH } from "./config.js";

interface Blueprint {
  preamble: { compiler?: { name: string; version: string }; plutusVersion: string };
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}

export function loadBlueprint(path = BLUEPRINT_PATH): Blueprint {
  return JSON.parse(readFileSync(path, "utf8")) as Blueprint;
}

export function compiledCode(title: string, bp = loadBlueprint()): string {
  const v = bp.validators.find((x) => x.title === title);
  if (!v) throw new Error(`validator ${title} not in blueprint; run \`aiken build\` in contracts/`);
  return v.compiledCode;
}

/** Aiken `cardano/address.Credential` as Plutus Data: VerificationKey = 0, Script = 1. */
export function credentialData(c: Credential): Data {
  return new Constr(c.type === "Key" ? 0 : 1, [c.hash]);
}

export interface BucketParams {
  drepId: string; // CIP-129 or CIP-105 drep1...
  approvedPoolKeyHashes: string[]; // hex blake2b-224 pool ids
}

/** Instantiate the bucket stake validator for one DRep. */
export function bucketStakeScript(p: BucketParams, bp = loadBlueprint()): Script {
  const code = compiledCode("bucket_stake.bucket_stake.publish", bp);
  const drep = drepIDToCredential(p.drepId);
  const applied = applyParamsToScript(code, [credentialData(drep), p.approvedPoolKeyHashes]);
  return { type: "PlutusV3", script: applied };
}

export function bucketIdentity(p: BucketParams, network: Network) {
  const script = bucketStakeScript(p);
  return {
    script,
    scriptHash: validatorToScriptHash(script),
    rewardAddress: validatorToRewardAddress(network, script),
  };
}
