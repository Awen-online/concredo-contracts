//// Vault creation mint (open question 2: how registration is guarded).
////
//// One token per vault creation, named by the vault's script hash. Minting is
//// allowed only when
////   (a) the token name is the hash of the genuine bucket_stake script for the
////       DRep and pools in the redeemer, rebuilt on chain (concredo/identity),
////       so no look-alike script can be passed off as a vault, and
////   (b) the same transaction carries a certificate that delegates that vault's
////       stake credential to its own DRep. A certificate naming a script
////       credential runs that script, so bucket_stake's own rules (own DRep,
////       approved pools) are enforced in the same transaction.
////
//// Two creation paths are accepted, because anyone can register a script stake
//// credential through the legacy certificate, which runs no script (Pondora v2
//// audit, POND2-001). If someone does that to a vault before we create it, the
//// combined register-and-delegate certificate fails, so:
////   - not yet registered: RegisterAndDelegateCredential (the normal path)
////   - already registered: DelegateCredential (recovers the vault)
////
//// Not yet decided (noted in docs/infrastructure.md, section 12):
////   - The token can be minted again by a later re-delegation of the same vault.
////     That is harmless for proving a vault is genuine (the hash does that), but
////     an index of vaults should key on the token name, not count tokens.
////   - Burning is refused until vault retirement exists.
////   - Where the token lives (wallet now; a registry output with day 3).

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId}
use cardano/certificate.{
  Certificate, Delegate, DelegateBoth, DelegateCredential,
  DelegateRepresentative, DelegateVote, RegisterAndDelegateCredential,
  Registered, StakePoolId,
}
use cardano/transaction.{Transaction}
use concredo/identity.{Template}

pub type CreateVault {
  drep: Credential,
  approved_pools: List<StakePoolId>,
}

validator vault_mint(template: Template) {
  mint(redeemer: CreateVault, policy_id: PolicyId, self: Transaction) {
    let vault = identity.vault_script_hash(
      template,
      redeemer.drep,
      redeemer.approved_pools,
    )
    expect [Pair(name, 1)] = dict.to_pairs(assets.tokens(self.mint, policy_id))
    and {
      name == vault,
      list.any(
        self.certificates,
        fn(c) { creates_vault(c, vault, redeemer.drep) },
      ),
    }
  }

  else(_) {
    fail
  }
}

/// True when the certificate delegates the vault's credential to its own DRep,
/// with or without registering it in the same certificate.
fn creates_vault(c: Certificate, vault: ByteArray, drep: Credential) -> Bool {
  when c is {
    RegisterAndDelegateCredential { credential: Script(h), delegate, .. } ->
      h == vault && votes_for(delegate, drep)
    DelegateCredential { credential: Script(h), delegate } ->
      h == vault && votes_for(delegate, drep)
    _ -> False
  }
}

fn votes_for(delegate: Delegate, drep: Credential) -> Bool {
  when delegate is {
    DelegateVote { delegate_representative } ->
      is_drep(delegate_representative, drep)
    DelegateBoth { delegate_representative, .. } ->
      is_drep(delegate_representative, drep)
    _ -> False
  }
}

fn is_drep(target: DelegateRepresentative, drep: Credential) -> Bool {
  when target is {
    Registered(c) -> c == drep
    _ -> False
  }
}

// ---------------------------------------------------------------------------
// Test fixtures: a stand-in template. The real one comes from the blueprint;
// the off-chain tests check the rebuilt hash against the real script.

const t = Template { prefix: [#"01", #"01"], middle: #"4c01", suffix: #"01" }

const drep_a: Credential =
  address.VerificationKey(
    #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  )

const drep_b: Credential =
  address.VerificationKey(
    #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  )

const policy: PolicyId =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

fn tx_with(name: ByteArray, qty: Int, certs: List<Certificate>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    mint: assets.from_asset(policy, name, qty),
    certificates: certs,
  }
}

fn try(tx: Transaction) -> Bool {
  vault_mint.mint(
    t,
    CreateVault { drep: drep_a, approved_pools: [] },
    policy,
    tx,
  )
}

fn vault_a() -> ByteArray {
  identity.vault_script_hash(t, drep_a, [])
}

// ---------------------------------------------------------------------------
// Unit tests

test mint_with_register_and_delegate() {
  try(
    tx_with(
      vault_a(),
      1,
      [
        RegisterAndDelegateCredential {
          credential: Script(vault_a()),
          delegate: DelegateVote(Registered(drep_a)),
          deposit: 2_000_000,
        },
      ],
    ),
  )
}

test mint_when_already_registered() {
  try(
    tx_with(
      vault_a(),
      1,
      [
        DelegateCredential {
          credential: Script(vault_a()),
          delegate: DelegateVote(Registered(drep_a)),
        },
      ],
    ),
  )
}

test mint_without_certificate_is_refused() fail {
  try(tx_with(vault_a(), 1, []))
}

test mint_for_lookalike_script_is_refused() fail {
  let fake = #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  try(
    tx_with(
      fake,
      1,
      [
        RegisterAndDelegateCredential {
          credential: Script(fake),
          delegate: DelegateVote(Registered(drep_a)),
          deposit: 2_000_000,
        },
      ],
    ),
  )
}

test mint_with_other_drep_is_refused() fail {
  try(
    tx_with(
      vault_a(),
      1,
      [
        DelegateCredential {
          credential: Script(vault_a()),
          delegate: DelegateVote(Registered(drep_b)),
        },
      ],
    ),
  )
}

test mint_two_is_refused() fail {
  try(
    tx_with(
      vault_a(),
      2,
      [
        DelegateCredential {
          credential: Script(vault_a()),
          delegate: DelegateVote(Registered(drep_a)),
        },
      ],
    ),
  )
}

test burn_is_refused() fail {
  try(tx_with(vault_a(), -1, []))
}
