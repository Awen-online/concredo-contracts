// Governance reads (DRep status and votes) for the DRep pay activity gate.
//
// Lucid's Provider interface has no governance queries, so this is a second,
// narrow interface with Koios and Blockfrost backends. The MVP pays DReps from
// an attested epoch snapshot built from these reads (see docs/infrastructure.md,
// section 5); the chain itself cannot be read for past votes from inside a script.

import type { Config } from "./config.js";

export interface DrepVote {
  proposalId: string; // CIP-129 gov_action1...
  voteTxHash: string;
  vote: "Yes" | "No" | "Abstain";
  blockTime: number;
  hasRationale: boolean; // anchor present (CIP-100 rationale), content not checked here
}

export interface DrepStatus {
  drepId: string;
  registered: boolean;
  active?: boolean;
  expiresEpoch?: number;
  votingPowerLovelace?: bigint;
}

export interface GovernanceReader {
  readonly name: string;
  drepStatus(drepId: string): Promise<DrepStatus>;
  drepVotes(drepId: string): Promise<DrepVote[]>;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export function koiosGovernance(cfg: Config): GovernanceReader {
  const { url, token } = cfg.koios;
  const h: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return {
    name: "koios",
    async drepStatus(drepId) {
      const res = await fetch(`${url}/drep_info`, {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ _drep_ids: [drepId] }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`POST ${url}/drep_info -> HTTP ${res.status}`);
      const [d] = (await res.json()) as any[];
      if (!d) return { drepId, registered: false };
      return {
        drepId,
        // Koios now returns drep_status ("registered" / "deregistered"); older responses had registered: bool.
        registered: d.drep_status != null ? d.drep_status !== "deregistered" : Boolean(d.registered),
        active: d.active ?? undefined,
        expiresEpoch: d.expires_epoch_no ?? undefined,
        votingPowerLovelace: d.amount != null ? BigInt(d.amount) : undefined,
      };
    },
    async drepVotes(drepId) {
      const rows = (await getJson(`${url}/drep_votes?_drep_id=${encodeURIComponent(drepId)}`, h)) as any[];
      return rows.map((r) => ({
        proposalId: r.proposal_id,
        voteTxHash: r.vote_tx_hash,
        vote: r.vote,
        blockTime: r.block_time,
        hasRationale: Boolean(r.meta_url),
      }));
    },
  };
}

export function blockfrostGovernance(cfg: Config): GovernanceReader {
  const { url, projectId } = cfg.blockfrost;
  if (!projectId) throw new Error("BLOCKFROST_PROJECT_ID is not set.");
  const h = { project_id: projectId };
  return {
    name: "blockfrost",
    async drepStatus(drepId) {
      const d = await getJson(`${url}/governance/dreps/${drepId}`, h);
      return {
        drepId,
        registered: !d.retired,
        active: Boolean(d.active) && !d.expired,
        // Blockfrost reports last_active_epoch and expired rather than an expiry epoch.
        votingPowerLovelace: d.amount != null ? BigInt(d.amount) : undefined,
      };
    },
    async drepVotes(drepId) {
      // Paginated at 100 rows; enough for an activity window. Extend if needed.
      const rows = (await getJson(`${url}/governance/dreps/${drepId}/votes?order=desc`, h)) as any[];
      return rows.map((r) => ({
        proposalId: r.proposal_id ?? `${r.proposal_tx_hash}#${r.proposal_cert_index}`,
        voteTxHash: r.tx_hash,
        vote: (r.vote.charAt(0).toUpperCase() + r.vote.slice(1)) as DrepVote["vote"],
        blockTime: 0, // not in this endpoint; join with /txs/{hash} if needed
        hasRationale: false, // needs a /txs/{hash}/metadata or votes anchor lookup
      }));
    },
  };
}

export function governanceFromConfig(cfg: Config): GovernanceReader {
  // Koios exposes everything the activity gate needs without a key.
  return cfg.primary === "blockfrost" ? blockfrostGovernance(cfg) : koiosGovernance(cfg);
}
