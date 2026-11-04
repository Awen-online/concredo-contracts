// The vault creation mint (contracts/validators/vault_mint.ak, open question 2).
//
// The policy rebuilds a vault's script hash on chain from three fixed pieces of
// the applied bucket_stake script (prefix, middle, suffix; see
// contracts/lib/concredo/identity.ak). This module reads those pieces out of
// the blueprint by applying placeholder parameters and splitting around them,
// then checks the split by rebuilding a real instance byte for byte.

import {
  applyParamsToScript,
  Constr,
  Data,
  drepIDToCredential,
  mintingPolicyToId,
  type Script,
} from "@lucid-evolution/lucid";
import { compiledCode, credentialData, loadBlueprint, type BucketParams } from "./blueprint.js";

export interface Template { prefix: string; middle: string; suffix: string }

const BUCKET = "bucket_stake.bucket_stake.publish";
const MINT = "vault_mint.vault_mint.mint";

/** Strip the two CBOR byte-string wrappers Lucid puts around flat script bytes. */
function unwrap(hex: string): string {
  const skip = (h: string) => {
    const ai = parseInt(h.slice(0, 2), 16) & 0x1f;
    const n = ai < 24 ? 0 : ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : NaN;
    if (Number.isNaN(n)) throw new Error("unexpected CBOR header");
    return h.slice(2 + 2 * n);
  };
  return skip(skip(hex));
}

/** Flat bytestring body: chunks of up to 255 bytes, each led by its length, then 00. */
export function flatChunks(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 510) {
    const c = hex.slice(i, i + 510);
    out += (c.length / 2).toString(16).padStart(2, "0") + c;
  }
  return out + "00";
}

/** The applied bucket_stake flat bytes, rebuilt from the template (mirrors identity.ak). */
export function rebuildFlat(t: Template, p: BucketParams): string {
  const drep = Data.to(credentialData(drepIDToCredential(p.drepId)));
  const pools = Data.to(p.approvedPoolKeyHashes as unknown as Data);
  return t.prefix + flatChunks(drep) + t.middle + flatChunks(pools) + t.suffix;
}

/** Read the template out of the blueprint, and prove it against a real instance. */
export function bucketTemplate(bp = loadBlueprint()): Template {
  const code = compiledCode(BUCKET, bp);
  const drep = credentialData({ type: "Key", hash: "00".repeat(28) });
  const flat = unwrap(applyParamsToScript(code, [drep, []]));
  const d = flatChunks(Data.to(drep));
  const p = flatChunks(Data.to([] as unknown as Data));
  const i = flat.lastIndexOf(d);
  const j = flat.indexOf(p, i + d.length);
  if (i < 0 || i % 2 || j < 0 || j % 2) throw new Error("could not locate parameters in bucket_stake");
  const t: Template = { prefix: flat.slice(0, i), middle: flat.slice(i + d.length, j), suffix: flat.slice(j + p.length) };

  // The split must reproduce a real instance with a non-trivial pool list.
  const probe: BucketParams = {
    drepId: "drep1yf3yx7ptr0hks02d7k8c8xfq58jn68nje5emscvv7a9ngpqudkpdh",
    approvedPoolKeyHashes: ["11".repeat(28), "22".repeat(28)],
  };
  const real = unwrap(applyParamsToScript(code, [credentialData(drepIDToCredential(probe.drepId)), probe.approvedPoolKeyHashes]));
  if (rebuildFlat(t, probe) !== real) throw new Error("bucket_stake template does not rebuild a real instance");
  return t;
}

/** The Template parameter as Plutus Data. The prefix goes in pieces of at most
 *  64 bytes: longer bytestrings are CBOR-chunked, and applyParamsToScript keeps
 *  only the first chunk (see identity.ak). */
export function templateData(t: Template): Constr<Data> {
  return new Constr(0, [t.prefix.match(/.{1,128}/g) ?? [], t.middle, t.suffix]);
}

export function vaultMintScript(bp = loadBlueprint()): Script {
  const applied = applyParamsToScript(compiledCode(MINT, bp), [templateData(bucketTemplate(bp))]);
  return { type: "PlutusV3", script: applied };
}

export function vaultMint(bp = loadBlueprint()) {
  const script = vaultMintScript(bp);
  return { script, policyId: mintingPolicyToId(script) };
}

/** Redeemer for the mint: the vault's DRep and approved pools (CreateVault). */
export function createVaultRedeemer(p: BucketParams): string {
  return Data.to(new Constr(0, [credentialData(drepIDToCredential(p.drepId)), p.approvedPoolKeyHashes]));
}
