//// Certificate rules for a Concredo bucket stake credential.
////
//// Settled design item 1 (docs/technical-supplement.md, section 2): the
//// bucket stake script reads the certificate itself and approves only
////   (a) vote delegation to the bucket's own DRep,
////   (b) block-production delegation to a pool on the approved list,
////   (c) Always Abstain as the fallback.
//// Everything else is refused. This module holds the pure decision logic so
//// it can be unit and property tested without building a full transaction.
////
//// PLACEHOLDER STATUS: this is the first preprod scaffold. Still TODO before
//// any deployment (see docs/infrastructure.md, section 11, and open questions 1, 2, 4):
////   - guard registration with the bucket-creation mint (open question 2),
////   - allow deregistration only when the bucket holds no collateral,
////   - the pro-rata reward sweep in the withdraw handler (open question 4),
////   - the inactive-DRep switch to Always Abstain (needs an attested input).

use aiken/collection/list
use cardano/address.{Credential}
use cardano/certificate.{
  AlwaysAbstain, AlwaysNoConfidence, Certificate, Delegate,
  DelegateBlockProduction, DelegateBoth, DelegateCredential,
  DelegateRepresentative, DelegateVote, RegisterAndDelegateCredential,
  Registered, StakePoolId,
}

/// A DRep target is allowed when it is the bucket's own DRep or Always Abstain.
/// Always No Confidence and any other DRep are refused.
pub fn drep_allowed(
  own_drep: Credential,
  target: DelegateRepresentative,
) -> Bool {
  when target is {
    Registered(credential) -> credential == own_drep
    AlwaysAbstain -> True
    AlwaysNoConfidence -> False
  }
}

/// A stake pool target is allowed only when it is on the approved list.
pub fn pool_allowed(
  approved_pools: List<StakePoolId>,
  pool: StakePoolId,
) -> Bool {
  list.has(approved_pools, pool)
}

/// Check a delegation (vote, block production, or both).
pub fn delegate_allowed(
  own_drep: Credential,
  approved_pools: List<StakePoolId>,
  delegate: Delegate,
) -> Bool {
  when delegate is {
    DelegateVote { delegate_representative } ->
      drep_allowed(own_drep, delegate_representative)
    DelegateBlockProduction { stake_pool } ->
      pool_allowed(approved_pools, stake_pool)
    DelegateBoth { stake_pool, delegate_representative } ->
      pool_allowed(approved_pools, stake_pool) && drep_allowed(
        own_drep,
        delegate_representative,
      )
  }
}

/// Decide whether the bucket stake script approves a certificate.
///
/// Approved: DelegateCredential and RegisterAndDelegateCredential whose
/// delegation passes `delegate_allowed`.
/// Refused (for now): UnregisterCredential (needs the "no collateral" check),
/// plain RegisterCredential (registration must go through the combined
/// register-and-delegate certificate so the script runs), and every DRep,
/// pool or committee certificate, which a bucket never issues.
pub fn certificate_allowed(
  own_drep: Credential,
  approved_pools: List<StakePoolId>,
  certificate: Certificate,
) -> Bool {
  when certificate is {
    DelegateCredential { delegate, .. } ->
      delegate_allowed(own_drep, approved_pools, delegate)
    RegisterAndDelegateCredential { delegate, .. } ->
      delegate_allowed(own_drep, approved_pools, delegate)
    _ -> False
  }
}
