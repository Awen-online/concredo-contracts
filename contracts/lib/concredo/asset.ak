//// A single named token: the stablecoin, the pool token, the oracle token.

use cardano/assets.{AssetName, Assets, PolicyId}

pub type Asset {
  policy: PolicyId,
  name: AssetName,
}

pub fn quantity(value: Assets, asset: Asset) -> Int {
  assets.quantity_of(value, asset.policy, asset.name)
}

/// `value` with `delta` more (or fewer) of `asset`, and nothing else changed.
pub fn shifted(value: Assets, asset: Asset, delta: Int) -> Assets {
  assets.add(value, asset.policy, asset.name, delta)
}
