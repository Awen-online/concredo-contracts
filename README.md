# Concredo contracts

On-chain code and off-chain transaction builders for **Concredo**, a Cardano lending protocol built for governance participation. Built by Ian McCullough (Awen).

Each DRep vault is its own Plutus V3 stake credential. ADA deposited in a vault stays staked and delegated to that vault's DRep, even while it backs a stablecoin loan. The DRep is a parameter of the vault script, so it is part of the script hash: anyone can rebuild the hash from this code and check which DRep a vault follows, and no key can re-point it.

> **Status: preprod only.** Not audited. Not deployed on mainnet. Test values only (mock price oracle, test stablecoin). Do not use with real funds.

## Layout

| Path | What |
|---|---|
| `contracts/validators/bucket_stake.ak` | Vault stake script, one per DRep. Its certificate branch allows only delegation to its own DRep, to an approved pool, or to Always Abstain; anything else is refused. |
| `contracts/validators/vault_mint.ak` | Vault creation mint: one token per genuine vault. Rebuilds the vault hash on chain and requires delegation to the vault's DRep in the same transaction. |
| `contracts/validators/lending.ak` | Shared lending validator. Every position is one UTxO at its vault's full address (payment part plus stake part); the output must stay at a genuine vault. |
| `contracts/validators/pool.ak` | Stablecoin pool: pays out only beside a position; anyone may top it up; no admin key. |
| `contracts/lib/concredo/` | Shared rules: certificate checks, vault identity, assets. |
| `contracts/plutus.json` | Committed blueprint. `aiken build` reproduces it exactly. |
| `deployments/preprod.json` | Deployed preprod scripts: hashes, parameters, compiler version and transaction hashes. |
| `offchain/` | Transaction builders and tests (TypeScript, Lucid Evolution 0.8.6). |

## Build and test

Requires Aiken **v1.1.24** (pinned in `contracts/aiken.toml`) and Node 22 or later.

```
cd contracts
aiken check          # 59 unit and property tests
aiken build          # writes plutus.json; it should match the committed file

cd ../offchain
npm install
npm test             # off-chain and emulator tests
```

## Verify the preprod deployment

1. Run `aiken build` and compare the validator hashes in `contracts/plutus.json` with the committed file.
2. Each vault in `deployments/preprod.json` lists its DRep, script hash, stake address, compiler and the transaction that created it. Look the transaction up on [preprod.cardanoscan.io](https://preprod.cardanoscan.io) to see the registration and vote delegation.
3. To rebuild a vault's hash yourself, apply its DRep and approved-pool list as parameters to `bucket_stake` and compare with the recorded `scriptHash`.
4. The `loans` entry records the lending and pool scripts. Apply its `config` as the single parameter to `lending` and compare with `lendingHash`; then apply that hash, `config.stable` and `config.poolToken` to `pool` and compare with `poolHash`. `lendingScript` and `poolScript` in `offchain/src/lending.ts` do exactly this. Entries under `loansHistory` were built from earlier commits and say which change replaced them.

## Not built yet

Liquidation, the interest curve, lender withdrawals, the pro-rata reward sweep, the DRep curator share, a gate on Always Abstain (anyone can set it today), a position token issued at creation, admin pause and timelock, the ADA market, pool concurrency, and a dApp.

## Design references

Some comments refer to numbered design questions. The specification that defines them will be published in this repository before the audit.

## License

Apache License 2.0. See `LICENSE`.
