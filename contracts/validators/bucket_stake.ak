//// Bucket stake validator (placeholder for the preprod scaffold).
////
//// One instance per DRep bucket. The DRep credential and the approved pool
//// list are validator parameters, so they are part of the script hash: anyone
//// can rebuild the hash from this code plus the published parameters and see
//// which DRep a bucket is bound to (settled design items 1 and 7; open
//// question 7 recommendation).
////
//// Handlers used by a stake credential under Plutus V3:
////   publish  : certificates naming this credential
////   withdraw : reward withdrawals from this credential
//// Everything else falls through to `else` and fails.

use aiken/fuzz
use cardano/address.{Credential, Script, VerificationKey}
use cardano/certificate.{
  AlwaysAbstain, AlwaysNoConfidence, Certificate, DelegateBlockProduction,
  DelegateBoth, DelegateCredential, DelegateVote, RegisterAndDelegateCredential,
  RegisterCredential, Registered, StakePoolId, UnregisterCredential,
}
use cardano/transaction.{Transaction}
use concredo/bucket

validator bucket_stake(
  own_drep: Credential,
  approved_pools: List<StakePoolId>,
) {
  publish(_redeemer: Data, certificate: Certificate, _self: Transaction) {
    bucket.certificate_allowed(own_drep, approved_pools, certificate)
  }

  withdraw(_redeemer: Data, _account: Credential, _self: Transaction) {
    // TODO (open question 4): permit the sweep only when the withdrawn
    // rewards are paid pro rata to the bucket's depositors, triggerable by
    // anyone. Until that logic exists, no withdrawal is allowed.
    False
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Test fixtures

const drep_a: Credential =
  VerificationKey(#"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

const drep_b: Credential =
  VerificationKey(#"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

const pool_ok: StakePoolId =
  #"11111111111111111111111111111111111111111111111111111111"

const pool_bad: StakePoolId =
  #"22222222222222222222222222222222222222222222222222222222"

const self_cred: Credential =
  Script(#"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc")

fn run(cert: Certificate) -> Bool {
  bucket_stake.publish(drep_a, [pool_ok], Void, cert, transaction.placeholder)
}

// ---------------------------------------------------------------------------
// Unit tests

test vote_to_own_drep_is_allowed() {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateVote(Registered(drep_a)),
    },
  )
}

test vote_to_other_drep_is_refused() fail {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateVote(Registered(drep_b)),
    },
  )
}

test always_abstain_is_allowed() {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateVote(AlwaysAbstain),
    },
  )
}

test always_no_confidence_is_refused() fail {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateVote(AlwaysNoConfidence),
    },
  )
}

test approved_pool_is_allowed() {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateBlockProduction(pool_ok),
    },
  )
}

test unapproved_pool_is_refused() fail {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateBlockProduction(pool_bad),
    },
  )
}

test register_and_delegate_both_is_allowed() {
  run(
    RegisterAndDelegateCredential {
      credential: self_cred,
      delegate: DelegateBoth {
        stake_pool: pool_ok,
        delegate_representative: Registered(drep_a),
      },
      deposit: 2_000_000,
    },
  )
}

test delegate_both_with_bad_pool_is_refused() fail {
  run(
    DelegateCredential {
      credential: self_cred,
      delegate: DelegateBoth {
        stake_pool: pool_bad,
        delegate_representative: Registered(drep_a),
      },
    },
  )
}

test deregistration_is_refused() fail {
  run(UnregisterCredential { credential: self_cred, refund: Never })
}

test plain_registration_is_refused() fail {
  run(RegisterCredential { credential: self_cred, deposit: Never })
}

test withdraw_is_refused_until_sweep_exists() fail {
  bucket_stake.withdraw(
    drep_a,
    [pool_ok],
    Void,
    self_cred,
    transaction.placeholder,
  )
}

// ---------------------------------------------------------------------------
// Property tests

/// No DRep other than the bucket's own is ever accepted.
test prop_foreign_drep_always_refused(key via fuzz.bytearray_fixed(28)) {
  let target = VerificationKey(key)
  let cert = DelegateCredential {
    credential: self_cred,
    delegate: DelegateVote(Registered(target)),
  }
  run(cert) == ( target == drep_a )
}

/// No pool off the approved list is ever accepted.
test prop_unlisted_pool_always_refused(pool via fuzz.bytearray_fixed(28)) {
  let cert = DelegateCredential {
    credential: self_cred,
    delegate: DelegateBlockProduction(pool),
  }
  run(cert) == ( pool == pool_ok )
}
