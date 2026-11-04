// Instantiate the bucket stake validator for a DRep and print its identity.
//
//   npm run blueprint -- drep1... [poolKeyHashHex,...]
//
// Prints the script hash and stake (reward) address that a bucket for that DRep
// would have. Anyone can rerun this from the published blueprint and parameters
// to verify which DRep a bucket is bound to (settled design item 7).

import { loadConfig } from "../src/config.js";
import { bucketIdentity, loadBlueprint } from "../src/blueprint.js";

const [drepId, pools] = process.argv.slice(2);
if (!drepId) {
  console.error("usage: npm run blueprint -- drep1... [poolHex,poolHex]");
  process.exit(1);
}
const cfg = loadConfig();
const bp = loadBlueprint();
const params = { drepId, approvedPoolKeyHashes: pools ? pools.split(",") : [] };
const id = bucketIdentity(params, cfg.network);

console.log(`compiler     : ${bp.preamble.compiler?.name} ${bp.preamble.compiler?.version}`);
console.log(`plutus       : ${bp.preamble.plutusVersion}`);
console.log(`drep         : ${drepId}`);
console.log(`pools        : ${params.approvedPoolKeyHashes.join(", ") || "(none)"}`);
console.log(`script hash  : ${id.scriptHash}`);
console.log(`stake address: ${id.rewardAddress}`);
