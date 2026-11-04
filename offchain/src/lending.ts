// The lending validator v1 and the stablecoin pool (contracts/validators/lending.ak,
// pool.ak): positions held at each vault's full address, lending script payment
// part plus vault stake part, with stablecoin loans against them.

import {
  applyParamsToScript,
  Constr,
  credentialToAddress,
  Data,
  drepIDToCredential,
  fromText,
  mintingPolicyToId,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import { bucketIdentity, compiledCode, credentialData, loadBlueprint, type BucketParams } from "./blueprint.js";
import { bucketTemplate, templateData } from "./vault-mint.js";

const LENDING = "lending.lending.spend";
const POOL = "pool.pool.spend";
const YEAR_MS = 31_536_000_000n;

/** A token: policy id and hex asset name. */
export interface Asset { policy: string; name: string }

export const unit = (a: Asset) => a.policy + a.name;
const assetData = (a: Asset) => new Constr(0, [a.policy, a.name]);

/** The lending Config parameter. Every number is a test value on preprod (open question 6). */
export interface LoanConfig {
  stable: Asset;
  poolToken: Asset;
  oracleToken: Asset;
  maxAgeMs: number;
  maxLtvBps: number;
  rateBps: number;
}

/** The test tokens: tUSD, the pool token and the oracle token, under one
 *  native policy signed by the test admin key. Used only on preprod. */
export function testTokens(adminKeyHash: string) {
  const policy = scriptFromNative({ type: "sig", keyHash: adminKeyHash });
  const id = mintingPolicyToId(policy);
  return {
    policy,
    tUSD: { policy: id, name: fromText("tUSD") },
    pool: { policy: id, name: fromText("POOL") },
    oracle: { policy: id, name: fromText("ORACLE") },
  };
}

export function lendingScript(c: LoanConfig, bp = loadBlueprint()): Script {
  const cfg = new Constr(0, [
    templateData(bucketTemplate(bp)),
    assetData(c.stable),
    assetData(c.poolToken),
    assetData(c.oracleToken),
    BigInt(c.maxAgeMs),
    BigInt(c.maxLtvBps),
    BigInt(c.rateBps),
  ]);
  return { type: "PlutusV3", script: applyParamsToScript(compiledCode(LENDING, bp), [cfg]) };
}

export function poolScript(c: LoanConfig, lending: Script, bp = loadBlueprint()): Script {
  const params = [validatorToScriptHash(lending), assetData(c.stable), assetData(c.poolToken)];
  return { type: "PlutusV3", script: applyParamsToScript(compiledCode(POOL, bp), params) };
}

export const poolAddress = (network: Network, pool: Script) => validatorToAddress(network, pool);

/** Where a position for this vault lives: lending payment part, vault stake part. */
export function positionAddress(network: Network, vault: BucketParams, lending: Script): string {
  const { scriptHash } = bucketIdentity(vault, network);
  return credentialToAddress(network, { type: "Script", hash: validatorToScriptHash(lending) }, { type: "Script", hash: scriptHash });
}

/** Inline datum: Position { owner, drep, approved_pools, debt, since }. */
export function positionDatum(ownerKeyHash: string, vault: BucketParams, debt = 0n, since = 0n): string {
  return Data.to(new Constr(0, [
    ownerKeyHash, credentialData(drepIDToCredential(vault.drepId)), vault.approvedPoolKeyHashes, debt, since,
  ]));
}

export function readPosition(datum: string): { owner: string; debt: bigint; since: bigint } {
  const c = Data.from(datum) as Constr<Data>;
  return { owner: c.fields[0] as string, debt: c.fields[3] as bigint, since: c.fields[4] as bigint };
}

/** Oracle datum: PriceFeed { price (stablecoin smallest units per 1 ADA), posted_at (ms) }. */
export const priceFeedDatum = (price: bigint, postedAt: bigint) => Data.to(new Constr(0, [price, postedAt]));

export function readPriceFeed(datum: string): { price: bigint; postedAt: bigint } {
  const c = Data.from(datum) as Constr<Data>;
  return { price: c.fields[0] as bigint, postedAt: c.fields[1] as bigint };
}

/** The loan with simple interest up to `now`, rounded up (mirrors lending.ak `owed`). */
export function owed(c: LoanConfig, debt: bigint, since: bigint, now: bigint): bigint {
  if (debt === 0n) return 0n;
  const elapsed = now > since ? now - since : 0n;
  const den = 10_000n * YEAR_MS;
  return debt + (debt * BigInt(c.rateBps) * elapsed + den - 1n) / den;
}

/** Largest loan this collateral supports at this price. */
export const maxLoan = (c: LoanConfig, lovelace: bigint, price: bigint) =>
  (lovelace * price * BigInt(c.maxLtvBps)) / (10_000n * 1_000_000n);

export const Action = {
  withdraw: () => Data.to(new Constr(0, [])),
  adjust: () => Data.to(new Constr(1, [])),
  move: (to: BucketParams) =>
    Data.to(new Constr(2, [credentialData(drepIDToCredential(to.drepId)), to.approvedPoolKeyHashes])),
  borrow: (amount: bigint) => Data.to(new Constr(3, [amount])),
  repay: (amount: bigint) => Data.to(new Constr(4, [amount])),
};

export const PoolAction = {
  lend: () => Data.to(new Constr(0, [])),
  supply: () => Data.to(new Constr(1, [])),
};
