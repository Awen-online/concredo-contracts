//// Stablecoin pool (docs/infrastructure.md, section 11, day 4).
////
//// One UTxO at this script holds the pool token and the stablecoin that
//// borrowers draw. It can be spent two ways:
////   Lend   : alongside a lending position. The lending validator checks the
////            pool's continuing output and that the stablecoin moved by exactly
////            the amount borrowed or repaid.
////   Supply : by anyone, to add stablecoin. Nothing else may change.
//// There is no admin key and no way to take stablecoin out except a loan.
//// Lender withdrawals, lender shares and the interest split come later.

use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use concredo/asset.{Asset}

pub type PoolAction {
  Lend
  Supply
}

validator pool(lending: ByteArray, stable: Asset, pool_token: Asset) {
  spend(
    _datum: Option<Data>,
    action: PoolAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
    let own = own_input.output
    and {
      asset.quantity(own.value, pool_token) == 1,
      when action is {
        Lend ->
          list.any(
            self.inputs,
            fn(i) { i.output.address.payment_credential == Script(lending) },
          )
        Supply -> {
          expect [out] = list.filter(
            self.outputs,
            fn(o) { asset.quantity(o.value, pool_token) > 0 },
          )
          let delta = asset.quantity(out.value, stable) - asset.quantity(
            own.value,
            stable,
          )
          and {
            delta > 0,
            out.address == own.address,
            out.datum == own.datum,
            out.reference_script == own.reference_script,
            out.value == asset.shifted(own.value, stable, delta),
          }
        }
      },
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests

const usd = Asset { policy: #"aa", name: "tUSD" }

const tok = Asset { policy: #"bb", name: "POOL" }

const lend_hash = #"1e1e"

const here =
  Address { payment_credential: Script(#"0909"), stake_credential: None }

const ref = OutputReference { transaction_id: #"00", output_index: 0 }

fn holding(n: Int) -> Output {
  Output {
    address: here,
    value: assets.from_lovelace(2_000_000)
      |> assets.add(tok.policy, tok.name, 1)
      |> assets.add(usd.policy, usd.name, n),
    datum: InlineDatum(Void),
    reference_script: None,
  }
}

fn spend(action: PoolAction, extra: List<Input>, outputs: List<Output>) -> Bool {
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [Input { output_reference: ref, output: holding(100) }, ..extra],
    outputs,
  }
  pool.spend(lend_hash, usd, tok, None, action, ref, self)
}

test supply_adds_stablecoin() {
  spend(Supply, [], [holding(150)])
}

test supply_cannot_take_stablecoin() fail {
  spend(Supply, [], [holding(50)])
}

test supply_cannot_move_the_pool() fail {
  spend(
    Supply,
    [],
    [
      Output {
        ..holding(150),
        address: Address {
          payment_credential: VerificationKey(#"ff"),
          stake_credential: None,
        },
      },
    ],
  )
}

test lend_needs_a_lending_input() fail {
  spend(Lend, [], [holding(50)])
}

test lend_with_a_lending_input() {
  let position = Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      ..holding(0),
      address: Address {
        payment_credential: Script(lend_hash),
        stake_credential: None,
      },
    },
  }
  spend(Lend, [position], [holding(50)])
}
