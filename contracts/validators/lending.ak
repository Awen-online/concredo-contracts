//// Lending validator v1: collateral positions held at each vault's full address,
//// with stablecoin loans (docs/infrastructure.md, section 11, days 3 and 4;
//// open questions 1 and 6).
////
//// A position is a UTxO whose address is
////   payment part: this script     (who can spend it)
////   stake part:   a vault script  (where it is staked and whose DRep it votes for)
//// with an inline datum naming its owner, DRep, approved pools and loan.
////
//// Actions, all signed by the owner:
////   Withdraw : take the position out. Only with no loan.
////   Adjust   : add or remove ADA; the position continues at the same full
////              address with the same datum.
////   Move     : switch vaults; the position continues at the address of the
////              genuine vault for the new DRep and pools. The loan moves with it.
////   Borrow   : draw stablecoin from the pool. The loan, with interest accrued
////              so far, must stay within the maximum loan-to-value at the
////              oracle price.
////   Repay    : return stablecoin to the pool, interest first.
////
//// The full-address rule: any continuing output must carry exactly the stake
//// part of the genuine vault for its datum's DRep and pools, rebuilt on chain
//// (concredo/identity). No redeemer, batch or key can point collateral at any
//// other stake credential (settled design, item 1; supplement section 2).
////
//// The collateral rule: while a loan is open, collateral can only go down if
//// the position is still within the maximum loan-to-value afterwards, checked
//// against a fresh oracle price.
////
//// Interest is simple interest at a fixed yearly rate on the loan, accrued
//// from the time it last changed and folded in at each Borrow or Repay. "Now"
//// is the upper bound of the transaction's validity range, which the borrower
//// cannot set earlier than the slot it lands in.
////
//// Not yet (day 5 onward): the interest curve, the interest split, lender
//// shares, liquidation, deposit caps, several oracle feeds. Every number in a
//// Config is a parameter: the preprod values are test values, not proposals
//// (open question 6). One position per transaction, so a single continuing
//// output can never satisfy two inputs (double satisfaction).

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/fuzz
use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{StakePoolId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use concredo/asset.{Asset}
use concredo/identity.{Template}

pub type Config {
  template: Template,
  /// The stablecoin lent.
  stable: Asset,
  /// The token that marks the one pool UTxO.
  pool_token: Asset,
  /// The token that marks the one oracle UTxO, read as a reference input.
  oracle_token: Asset,
  /// The oldest price accepted, in milliseconds after it was posted.
  max_age: Int,
  /// Maximum loan-to-value, in basis points.
  max_ltv: Int,
  /// Yearly interest, in basis points.
  rate: Int,
}

pub type Position {
  owner: VerificationKeyHash,
  drep: Credential,
  approved_pools: List<StakePoolId>,
  /// Stablecoin owed at `since`, in its smallest unit.
  debt: Int,
  /// When `debt` was last set (POSIX milliseconds).
  since: Int,
}

/// Oracle datum: stablecoin units (smallest unit) per 1 ADA, and when posted.
pub type PriceFeed {
  price: Int,
  posted_at: Int,
}

pub type Action {
  Withdraw
  Adjust
  Move { drep: Credential, approved_pools: List<StakePoolId> }
  Borrow { amount: Int }
  Repay { amount: Int }
}

const year_ms = 31_536_000_000

validator lending(cfg: Config) {
  spend(
    datum: Option<Position>,
    action: Action,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(position) = datum
    expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
    let own_payment = own_input.output.address.payment_credential
    let before = assets.lovelace_of(own_input.output.value)
    and {
      list.count(
        self.inputs,
        fn(i) { i.output.address.payment_credential == own_payment },
      ) == 1,
      list.has(self.extra_signatories, position.owner),
      when action is {
        Withdraw -> and {
            position.debt == 0,
            !touches_pool(cfg, self),
          }
        Adjust -> keeps_loan(cfg, self, own_payment, position, before)
        Move { drep, approved_pools } ->
          keeps_loan(
            cfg,
            self,
            own_payment,
            Position { ..position, drep, approved_pools },
            before,
          )
        Borrow { amount } -> {
          let now = upper_bound(self)
          let next = Position {
            ..position,
            debt: owed(cfg, position, now) + amount,
            since: now,
          }
          when continuing(cfg.template, self.outputs, own_payment, next) is {
            Some(after) -> and {
                amount > 0,
                pool_flow(cfg, self) == -amount,
                healthy(cfg, self, after, next.debt),
              }
            None -> False
          }
        }
        Repay { amount } -> {
          let now = upper_bound(self)
          let next = Position {
            ..position,
            debt: owed(cfg, position, now) - amount,
            since: now,
          }
          when continuing(cfg.template, self.outputs, own_payment, next) is {
            Some(after) -> and {
                amount > 0,
                next.debt >= 0,
                pool_flow(cfg, self) == amount,
                or {
                  next.debt == 0,
                  after >= before,
                  healthy(cfg, self, after, next.debt),
                },
              }
            None -> False
          }
        }
      },
    }
  }

  else(_) {
    fail
  }
}

/// Adjust and Move: the loan is unchanged, the pool is untouched, and if
/// collateral goes down the position must still be healthy.
fn keeps_loan(
  cfg: Config,
  self: Transaction,
  own_payment: Credential,
  next: Position,
  before: Int,
) -> Bool {
  when continuing(cfg.template, self.outputs, own_payment, next) is {
    Some(after) -> and {
        !touches_pool(cfg, self),
        or {
          next.debt == 0,
          after >= before,
          healthy(cfg, self, after, owed(cfg, next, upper_bound(self))),
        },
      }
    None -> False
  }
}

/// Exactly one output goes back to this script. Its stake part is the genuine
/// vault for `next`, its inline datum is `next`, and it holds only ADA.
/// Returns that output's lovelace, or None if any of this fails.
fn continuing(
  template: Template,
  outputs: List<Output>,
  own_payment: Credential,
  next: Position,
) -> Option<Int> {
  let vault = identity.vault_script_hash(
    template,
    next.drep,
    next.approved_pools,
  )
  let datum: Data = next
  when
    list.filter(outputs, fn(o) { o.address.payment_credential == own_payment })
  is {
    [out] ->
      if and {
        out.address.stake_credential == Some(Inline(Script(vault))),
        out.datum == InlineDatum(datum),
        assets.without_lovelace(out.value) == assets.zero,
      } {
        Some(assets.lovelace_of(out.value))
      } else {
        None
      }
    _ -> None
  }
}

/// The loan with simple interest up to `now`, rounded up in the pool's favour.
fn owed(cfg: Config, p: Position, now: Int) -> Int {
  if p.debt == 0 {
    0
  } else {
    let elapsed = if now > p.since {
      now - p.since
    } else {
      0
    }
    let den = 10_000 * year_ms
    p.debt + ( p.debt * cfg.rate * elapsed + den - 1 ) / den
  }
}

fn upper_bound(self: Transaction) -> Int {
  expect Finite(t) = self.validity_range.upper_bound.bound_type
  t
}

/// The loan is within the maximum loan-to-value at a fresh oracle price.
fn healthy(cfg: Config, self: Transaction, lovelace: Int, debt: Int) -> Bool {
  expect [feed_input] = list.filter(
    self.reference_inputs,
    fn(i) { asset.quantity(i.output.value, cfg.oracle_token) == 1 },
  )
  expect InlineDatum(raw) = feed_input.output.datum
  expect feed: PriceFeed = raw
  expect Finite(from) = self.validity_range.lower_bound.bound_type
  and {
    feed.price > 0,
    feed.posted_at <= from,
    upper_bound(self) <= feed.posted_at + cfg.max_age,
    debt * 10_000 * 1_000_000 <= lovelace * feed.price * cfg.max_ltv,
  }
}

fn holds_pool_token(cfg: Config, o: Output) -> Bool {
  asset.quantity(o.value, cfg.pool_token) > 0
}

fn touches_pool(cfg: Config, self: Transaction) -> Bool {
  list.any(self.inputs, fn(i) { holds_pool_token(cfg, i.output) })
}

/// The pool is spent once and continues at the same address with the same
/// datum; only its stablecoin changes. Returns that change.
fn pool_flow(cfg: Config, self: Transaction) -> Int {
  expect [pool_in] = list.filter(
    self.inputs,
    fn(i) { holds_pool_token(cfg, i.output) },
  )
  expect [pool_out] = list.filter(self.outputs, holds_pool_token(cfg, _))
  let was = pool_in.output
  let delta = asset.quantity(pool_out.value, cfg.stable) - asset.quantity(
    was.value,
    cfg.stable,
  )
  expect and {
      pool_out.address == was.address,
      pool_out.datum == was.datum,
      pool_out.reference_script == was.reference_script,
      pool_out.value == asset.shifted(was.value, cfg.stable, delta),
    }
  delta
}

// ---------------------------------------------------------------------------
// Test fixtures (stand-in template and test values; the off-chain tests use
// the real template)

const t = Template { prefix: [#"01", #"01"], middle: #"4c01", suffix: #"01" }

const usd = Asset { policy: #"aa", name: "tUSD" }

const cfg =
  Config {
    template: t,
    stable: usd,
    pool_token: Asset { policy: #"bb", name: "POOL" },
    oracle_token: Asset { policy: #"cc", name: "ORACLE" },
    max_age: 600_000,
    max_ltv: 5_000,
    rate: 1_000,
  }

const me: VerificationKeyHash =
  #"0000000000000000000000000000000000000000000000000000aaaa"

const drep_a: Credential =
  VerificationKey(#"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

const drep_b: Credential =
  VerificationKey(#"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

const lend: Credential =
  Script(#"1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e")

const ref = OutputReference { transaction_id: #"00", output_index: 0 }

const t0 = 1_800_000_000_000

/// 100 ADA of collateral at 0.70 tUSD per ADA, test LTV 50%: room for 35 tUSD.
const ada100 = 100_000_000

fn pos(drep: Credential) -> Position {
  Position { owner: me, drep, approved_pools: [], debt: 0, since: 0 }
}

fn loan(debt: Int, since: Int) -> Position {
  Position { ..pos(drep_a), debt, since }
}

fn at(drep: Credential) -> Address {
  Address {
    payment_credential: lend,
    stake_credential: Some(
      Inline(Script(identity.vault_script_hash(t, drep, []))),
    ),
  }
}

fn utxo(address: Address, p: Position, lovelace: Int) -> Output {
  let d: Data = p
  Output {
    address,
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn pool_at(n: Int) -> Output {
  Output {
    address: Address {
      payment_credential: Script(#"0909"),
      stake_credential: None,
    },
    value: assets.from_lovelace(2_000_000)
      |> assets.add(#"bb", "POOL", 1)
      |> assets.add(usd.policy, usd.name, n),
    datum: InlineDatum(Void),
    reference_script: None,
  }
}

fn oracle(price: Int, posted_at: Int) -> Input {
  let d: Data = PriceFeed { price, posted_at }
  Input {
    output_reference: OutputReference { transaction_id: #"0c", output_index: 0 },
    output: Output {
      address: Address {
        payment_credential: VerificationKey(#"0c"),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000) |> assets.add(#"cc", "ORACLE", 1),
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

fn pool_input(n: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"0b", output_index: 0 },
    output: pool_at(n),
  }
}

fn between(from: Int, to: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(from), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(to), is_inclusive: False },
  }
}

fn tx(outputs: List<Output>, signers: List<VerificationKeyHash>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: ref,
        output: utxo(at(drep_a), pos(drep_a), ada100),
      },
    ],
    outputs,
    extra_signatories: signers,
  }
}

/// A transaction spending `held` (a position worth `lovelace`) with the pool
/// and a fresh price of 0.70, valid from t0 to `to`.
fn loan_tx(
  held: Position,
  lovelace: Int,
  pool_in: Int,
  outputs: List<Output>,
  to: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input { output_reference: ref, output: utxo(at(drep_a), held, lovelace) },
      pool_input(pool_in),
    ],
    reference_inputs: [oracle(700_000, t0)],
    outputs,
    extra_signatories: [me],
    validity_range: between(t0, to),
  }
}

fn run(action: Action, self: Transaction) -> Bool {
  lending.spend(cfg, Some(pos(drep_a)), action, ref, self)
}

fn run_with(held: Position, action: Action, self: Transaction) -> Bool {
  lending.spend(cfg, Some(held), action, ref, self)
}

const later = t0 + 60_000

// ---------------------------------------------------------------------------
// Positions without a loan (day 3)

test owner_can_withdraw() {
  run(Withdraw, tx([], [me]))
}

test stranger_cannot_withdraw() fail {
  run(Withdraw, tx([], [#"ff"]))
}

test adjust_keeps_the_full_address() {
  run(Adjust, tx([utxo(at(drep_a), pos(drep_a), 150_000_000)], [me]))
}

test adjust_to_another_vault_is_refused() fail {
  run(Adjust, tx([utxo(at(drep_b), pos(drep_a), ada100)], [me]))
}

test adjust_to_a_key_stake_part_is_refused() fail {
  let address = Address {
    payment_credential: lend,
    stake_credential: Some(Inline(VerificationKey(me))),
  }
  run(Adjust, tx([utxo(address, pos(drep_a), ada100)], [me]))
}

test adjust_with_no_stake_part_is_refused() fail {
  let address = Address { payment_credential: lend, stake_credential: None }
  run(Adjust, tx([utxo(address, pos(drep_a), ada100)], [me]))
}

test adjust_cannot_rewrite_the_datum() fail {
  run(Adjust, tx([utxo(at(drep_a), pos(drep_b), ada100)], [me]))
}

test move_to_the_genuine_vault() {
  run(
    Move { drep: drep_b, approved_pools: [] },
    tx([utxo(at(drep_b), pos(drep_b), ada100)], [me]),
  )
}

test move_with_mismatched_vault_is_refused() fail {
  run(
    Move { drep: drep_b, approved_pools: [] },
    tx([utxo(at(drep_a), pos(drep_b), ada100)], [me]),
  )
}

test two_continuing_outputs_are_refused() fail {
  run(
    Adjust,
    tx(
      [
        utxo(at(drep_a), pos(drep_a), 50_000_000),
        utxo(at(drep_a), pos(drep_a), 50_000_000),
      ],
      [me],
    ),
  )
}

test tokens_in_a_position_are_refused() fail {
  let out = Output {
    ..utxo(at(drep_a), pos(drep_a), ada100),
    value: assets.add(assets.from_lovelace(ada100), #"cc", #"", 1),
  }
  run(Adjust, tx([out], [me]))
}

test two_position_inputs_are_refused() fail {
  let second = Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: utxo(at(drep_a), pos(drep_a), ada100),
  }
  let base = tx([utxo(at(drep_a), pos(drep_a), 200_000_000)], [me])
  run(Adjust, Transaction { ..base, inputs: [second, ..base.inputs] })
}

/// Whatever stake credential an attacker supplies, Adjust accepts only the vault's.
test prop_adjust_only_to_own_vault(h via fuzz.bytearray_fixed(28)) {
  let address = Address {
    payment_credential: lend,
    stake_credential: Some(Inline(Script(h))),
  }
  run(Adjust, tx([utxo(address, pos(drep_a), ada100)], [me])) == (
    h == identity.vault_script_hash(t, drep_a, [])
  )
}

// ---------------------------------------------------------------------------
// Loans (day 4)

test borrow_within_ltv() {
  run(
    Borrow { amount: 30_000_000 },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(30_000_000, later), ada100), pool_at(70_000_000)],
      later,
    ),
  )
}

test borrow_over_ltv_is_refused() fail {
  run(
    Borrow { amount: 36_000_000 },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(36_000_000, later), ada100), pool_at(64_000_000)],
      later,
    ),
  )
}

test borrow_must_take_it_from_the_pool() fail {
  run(
    Borrow { amount: 30_000_000 },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(30_000_000, later), ada100), pool_at(90_000_000)],
      later,
    ),
  )
}

test borrow_with_a_stale_price_is_refused() fail {
  let to = t0 + cfg.max_age + 1
  run(
    Borrow { amount: 30_000_000 },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(30_000_000, to), ada100), pool_at(70_000_000)],
      to,
    ),
  )
}

test borrow_cannot_understate_the_debt() fail {
  run(
    Borrow { amount: 30_000_000 },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(20_000_000, later), ada100), pool_at(70_000_000)],
      later,
    ),
  )
}

test borrow_cannot_drain_other_pool_value() fail {
  let drained = Output {
    ..pool_at(70_000_000),
    value: assets.add(pool_at(70_000_000).value, #"", #"", -1_000_000),
  }
  run(
    Borrow { amount: 30_000_000 },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(30_000_000, later), ada100), drained],
      later,
    ),
  )
}

/// One year at 10% on 30 tUSD: 33 tUSD owed.
test interest_accrues_for_a_year() {
  owed(cfg, loan(30_000_000, t0), t0 + year_ms) == 33_000_000
}

test interest_rounds_up() {
  owed(cfg, loan(1, t0), t0 + 1) == 2
}

test repay_in_full_then_withdraw() {
  let held = loan(30_000_000, t0 - year_ms)
  and {
    run_with(
      held,
      Repay { amount: 33_000_006 },
      loan_tx(
        held,
        ada100,
        70_000_000,
        [utxo(at(drep_a), loan(0, later), ada100), pool_at(103_000_006)],
        later,
      ),
    ),
    // A year and a minute at 10% on 30 tUSD.
    owed(cfg, held, later) == 33_000_006,
  }
}

test repay_more_than_owed_is_refused() fail {
  let held = loan(30_000_000, t0)
  run_with(
    held,
    Repay { amount: 40_000_000 },
    loan_tx(
      held,
      ada100,
      70_000_000,
      [utxo(at(drep_a), loan(-9_999_658, later), ada100), pool_at(110_000_000)],
      later,
    ),
  )
}

test withdraw_with_a_loan_is_refused() fail {
  let held = loan(30_000_000, t0)
  run_with(
    held,
    Withdraw,
    Transaction {
      ..tx([], [me]),
      inputs: [
        Input { output_reference: ref, output: utxo(at(drep_a), held, ada100) },
      ],
    },
  )
}

test withdraw_cannot_touch_the_pool() fail {
  run(
    Withdraw,
    Transaction {
      ..tx([pool_at(0)], [me]),
      inputs: [
        Input {
          output_reference: ref,
          output: utxo(at(drep_a), pos(drep_a), ada100),
        },
        pool_input(100_000_000),
      ],
    },
  )
}

test adjust_down_with_a_loan_stays_healthy() {
  let held = loan(30_000_000, t0)
  run_with(
    held,
    Adjust,
    Transaction {
      ..loan_tx(held, ada100, 0, [utxo(at(drep_a), held, 90_000_000)], later),
      inputs: [
        Input { output_reference: ref, output: utxo(at(drep_a), held, ada100) },
      ],
    },
  )
}

test adjust_down_past_ltv_is_refused() fail {
  let held = loan(30_000_000, t0)
  run_with(
    held,
    Adjust,
    Transaction {
      ..loan_tx(held, ada100, 0, [utxo(at(drep_a), held, 80_000_000)], later),
      inputs: [
        Input { output_reference: ref, output: utxo(at(drep_a), held, ada100) },
      ],
    },
  )
}

test move_keeps_the_loan() {
  let held = loan(30_000_000, t0)
  run_with(
    held,
    Move { drep: drep_b, approved_pools: [] },
    Transaction {
      ..tx([utxo(at(drep_b), Position { ..held, drep: drep_b }, ada100)], [me]),
      inputs: [
        Input { output_reference: ref, output: utxo(at(drep_a), held, ada100) },
      ],
    },
  )
}

test move_cannot_drop_the_loan() fail {
  let held = loan(30_000_000, t0)
  run_with(
    held,
    Move { drep: drep_b, approved_pools: [] },
    Transaction {
      ..tx(
        [utxo(at(drep_b), Position { ..held, drep: drep_b, debt: 0 }, ada100)],
        [me],
      ),
      inputs: [
        Input { output_reference: ref, output: utxo(at(drep_a), held, ada100) },
      ],
    },
  )
}

/// Any borrow amount is accepted exactly when it fits the test LTV (35 tUSD
/// against 100 ADA at 0.70).
test prop_borrow_only_within_ltv(n via fuzz.int_between(1, 70_000_000)) {
  run(
    Borrow { amount: n },
    loan_tx(
      pos(drep_a),
      ada100,
      100_000_000,
      [utxo(at(drep_a), loan(n, later), ada100), pool_at(100_000_000 - n)],
      later,
    ),
  ) == ( n <= 35_000_000 )
}
