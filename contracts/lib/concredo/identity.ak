//// Rebuild a vault's script hash on chain from its DRep and approved pools.
////
//// Settled design item 7 says anyone can rebuild a vault's hash from the
//// published code and parameters. This module does the same inside a script,
//// so a validator can check that a stake credential is a genuine Concredo
//// vault bound to a given DRep, with no registry and no admin key
//// (open questions 2 and 7).
////
//// Layout of an applied bucket_stake script (verified against
//// applyParamsToScript in offchain/test/vault-mint.test.ts):
////
////   flat   = prefix ++ chunks(cbor(drep)) ++ middle ++ chunks(cbor(pools)) ++ suffix
////   hash   = blake2b_224(0x03 ++ cbor_bytes_header(length(flat)) ++ flat)
////
//// Parameters are Data constants, and UPLC flat encodes a Data constant as the
//// bytestring of its CBOR. Flat bytestrings start on a byte boundary and are
//// written as chunks of at most 255 bytes, each led by its length, ending with
//// 0x00. So the parameters land byte aligned, and everything else (`prefix`,
//// `middle`, `suffix`) is fixed by the compiled bucket_stake code. The off-chain
//// code reads those three pieces from the blueprint (offchain/src/vault-mint.ts).
////
//// The prefix is a few hundred bytes, so it is passed as a list of pieces of at
//// most 64 bytes. A longer bytestring parameter is CBOR-encoded in chunks, and
//// Lucid Evolution 0.8.6 kept only the first chunk when applying it (found in
//// the emulator: the policy saw a 64-byte prefix).

use aiken/cbor
use aiken/collection/list
use aiken/crypto.{ScriptHash, blake2b_224}
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/certificate.{StakePoolId}

/// The fixed parts of the applied bucket_stake script, from the blueprint.
pub type Template {
  prefix: List<ByteArray>,
  middle: ByteArray,
  suffix: ByteArray,
}

/// UPLC flat encoding of a bytestring body: chunks of at most 255 bytes,
/// each preceded by its length byte, then a 0x00 terminator.
pub fn flat_chunks(bytes: ByteArray) -> ByteArray {
  let n = bytearray.length(bytes)
  if n == 0 {
    #"00"
  } else if n <= 255 {
    bytearray.concat(bytearray.push(bytes, n), #"00")
  } else {
    bytearray.concat(
      bytearray.push(bytearray.take(bytes, 255), 255),
      flat_chunks(bytearray.drop(bytes, 255)),
    )
  }
}

/// CBOR major type 2 (byte string) header for a payload of `n` bytes.
pub fn cbor_bytes_header(n: Int) -> ByteArray {
  if n < 24 {
    bytearray.from_int_big_endian(64 + n, 1)
  } else if n < 256 {
    bytearray.push(bytearray.from_int_big_endian(n, 1), 0x58)
  } else if n < 65536 {
    bytearray.push(bytearray.from_int_big_endian(n, 2), 0x59)
  } else {
    bytearray.push(bytearray.from_int_big_endian(n, 4), 0x5a)
  }
}

/// The script hash of the bucket_stake instance for this DRep and pool list.
pub fn vault_script_hash(
  template: Template,
  drep: Credential,
  approved_pools: List<StakePoolId>,
) -> ScriptHash {
  let flat = list.foldr(template.prefix, #"", bytearray.concat)
    |> bytearray.concat(flat_chunks(cbor.serialise(drep)))
    |> bytearray.concat(template.middle)
    |> bytearray.concat(flat_chunks(cbor.serialise(approved_pools)))
    |> bytearray.concat(template.suffix)
  blake2b_224(
    bytearray.concat(
      #"03",
      bytearray.concat(cbor_bytes_header(bytearray.length(flat)), flat),
    ),
  )
}

// ---------------------------------------------------------------------------
// Unit tests

test flat_chunks_empty() {
  flat_chunks(#"") == #"00"
}

test flat_chunks_short() {
  flat_chunks(#"abcd") == #"02abcd00"
}

test flat_chunks_splits_at_255() {
  let bytes = bytearray.from_int_big_endian(0, 300)
  let out = flat_chunks(bytes)
  and {
    bytearray.length(out) == 1 + 255 + 1 + 45 + 1,
    bytearray.at(out, 0) == 255,
    bytearray.at(out, 256) == 45,
    bytearray.at(out, 302) == 0,
  }
}

test cbor_header_sizes() {
  and {
    cbor_bytes_header(5) == #"45",
    cbor_bytes_header(34) == #"5822",
    cbor_bytes_header(444) == #"5901bc",
    cbor_bytes_header(70000) == #"5a00011170",
  }
}
