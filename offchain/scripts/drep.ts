// Read a DRep's status and recent votes (the inputs to the DRep pay activity gate).
//
//   npm run drep -- drep1...

import { loadConfig } from "../src/config.js";
import { governanceFromConfig } from "../src/governance.js";

const drepId = process.argv[2];
if (!drepId) {
  console.error("usage: npm run drep -- drep1...");
  process.exit(1);
}
const gov = governanceFromConfig(loadConfig());
const status = await gov.drepStatus(drepId);
const votes = await gov.drepVotes(drepId);
console.log(`source : ${gov.name}`);
console.log(`status : ${JSON.stringify(status, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log(`votes  : ${votes.length}`);
for (const v of votes.slice(0, 5)) {
  console.log(`  ${v.vote.padEnd(7)} ${v.proposalId}${v.hasRationale ? " (rationale)" : ""}`);
}
