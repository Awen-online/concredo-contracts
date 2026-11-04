// Small Koios helpers shared by the preprod scripts.

import type { Config } from "./config.js";

export function koios(cfg: Config) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.koios.token) headers.authorization = `Bearer ${cfg.koios.token}`;

  async function post(endpoint: string, body: unknown): Promise<any> {
    const res = await fetch(`${cfg.koios.url}/${endpoint}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`POST ${cfg.koios.url}/${endpoint} -> HTTP ${res.status}`);
    return res.json();
  }

  async function get(query: string): Promise<any> {
    const res = await fetch(`${cfg.koios.url}/${query}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GET ${cfg.koios.url}/${query} -> HTTP ${res.status}`);
    return res.json();
  }

  return {
    post,
    get,
    /** Registration status, DRep and pool of a stake address. */
    async accountInfo(stakeAddress: string): Promise<{ status: string; delegated_drep?: string; delegated_pool?: string } | undefined> {
      const [row] = await post("account_info", { _stake_addresses: [stakeAddress] });
      return row;
    },
    /** The pool's key hash in hex, which is what the vault script parameter holds. */
    async poolHexId(bech32: string): Promise<string> {
      const [p] = (await post("pool_info", { _pool_bech32_ids: [bech32] })) as Array<{ pool_id_hex: string; pool_status: string }>;
      if (!p || p.pool_status !== "registered") throw new Error(`pool ${bech32} is not registered on ${cfg.network}`);
      return p.pool_id_hex;
    },
    /** Poll until the stake address reaches the wanted state (Lucid's awaitTx can misparse Koios). */
    async waitFor(stakeAddress: string, done: (a: { status: string; delegated_drep?: string } | undefined) => boolean, tries = 30) {
      let a = await this.accountInfo(stakeAddress);
      for (let i = 0; i < tries && !done(a); i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        a = await this.accountInfo(stakeAddress);
      }
      return a;
    },
    async txConfirmed(txHash: string, tries = 30): Promise<boolean> {
      for (let i = 0; i < tries; i++) {
        const rows = (await post("tx_status", { _tx_hashes: [txHash] })) as Array<{ num_confirmations: number | null }>;
        if (rows[0]?.num_confirmations) return true;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      return false;
    },
  };
}
