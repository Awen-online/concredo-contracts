// Provider abstraction: one ChainProvider interface, several backends, chosen by env.
//
//   CARDANO_PROVIDER=koios|blockfrost|kupmios        (primary, default koios)
//   CARDANO_PROVIDER_FALLBACK=koios|blockfrost|kupmios|none
//
// A ChainProvider is a Lucid Evolution `Provider` (so it plugs straight into
// `Lucid(...)` for tx building, evaluation and submission) plus `getTip()`,
// which Lucid's interface lacks. `FallbackProvider` tries the primary and, on
// any error, retries the same call on the fallback. Contract code must never
// import a concrete backend directly; it takes a ChainProvider.

import { Blockfrost, Koios, Kupmios, type Provider } from "@lucid-evolution/lucid";
import type { Config, ProviderName } from "./config.js";

export interface Tip {
  slot: number;
  hash: string;
  height?: number;
  epoch?: number;
  time?: number; // unix seconds
}

export interface ChainProvider extends Provider {
  readonly name: string;
  getTip(): Promise<Tip>;
}

type TipFn = () => Promise<Tip>;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Attach a name and a tip query to a Lucid provider without changing its behaviour. */
function withTip(name: string, inner: Provider, getTip: TipFn): ChainProvider {
  return new Proxy(inner as ChainProvider, {
    get(target, prop, receiver) {
      if (prop === "name") return name;
      if (prop === "getTip") return getTip;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function koios(cfg: Config): ChainProvider {
  const { url, token } = cfg.koios;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return withTip("koios", new Koios(url, token), async () => {
    const [t] = (await getJson(`${url}/tip`, { headers })) as Array<{
      hash: string; epoch_no: number; abs_slot: number; block_height: number; block_time: number;
    }>;
    return { slot: t.abs_slot, hash: t.hash, height: t.block_height, epoch: t.epoch_no, time: t.block_time };
  });
}

function blockfrost(cfg: Config): ChainProvider {
  const { url, projectId } = cfg.blockfrost;
  if (!projectId) {
    throw new Error("BLOCKFROST_PROJECT_ID is not set. Create a free preprod project at blockfrost.io and put its ID in offchain/.env.");
  }
  return withTip("blockfrost", new Blockfrost(url, projectId), async () => {
    const b = (await getJson(`${url}/blocks/latest`, { headers: { project_id: projectId } })) as {
      hash: string; slot: number; height: number; epoch: number; time: number;
    };
    return { slot: b.slot, hash: b.hash, height: b.height, epoch: b.epoch, time: b.time };
  });
}

function kupmios(cfg: Config): ChainProvider {
  const { kupoUrl, ogmiosUrl } = cfg.kupmios;
  if (!kupoUrl || !ogmiosUrl) {
    throw new Error("KUPO_URL and OGMIOS_URL must both be set for the kupmios provider (self-hosted, Yaci DevKit, or a hosted endpoint).");
  }
  return withTip("kupmios", new Kupmios(kupoUrl, ogmiosUrl), async () => {
    const r = (await getJson(ogmiosUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip" }),
    })) as { result: { slot: number; id: string } };
    return { slot: r.result.slot, hash: r.result.id };
  });
}

export function makeProvider(name: ProviderName, cfg: Config): ChainProvider {
  switch (name) {
    case "koios": return koios(cfg);
    case "blockfrost": return blockfrost(cfg);
    case "kupmios": return kupmios(cfg);
  }
}

/**
 * Calls the primary; if it throws, logs and retries the same call on the fallback.
 * Submission is retried too: resubmitting an identical signed tx is idempotent
 * at the ledger level (the second copy is rejected as already spent or known).
 */
export class FallbackProvider {
  constructor(
    readonly primary: ChainProvider,
    readonly fallback: ChainProvider,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  static wrap(primary: ChainProvider, fallback: ChainProvider, log?: (msg: string) => void): ChainProvider {
    const fp = new FallbackProvider(primary, fallback, log);
    return new Proxy(primary, {
      get(target, prop) {
        if (prop === "name") return `${primary.name}>${fallback.name}`;
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => fp.call(prop as keyof ChainProvider, args);
      },
    });
  }

  async call(method: keyof ChainProvider, args: unknown[]): Promise<unknown> {
    const p = this.primary[method] as unknown as ((...a: unknown[]) => Promise<unknown>) | undefined;
    try {
      if (typeof p !== "function") throw new Error(`${this.primary.name} lacks ${String(method)}`);
      return await p.apply(this.primary, args);
    } catch (err) {
      const f = this.fallback[method] as unknown as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof f !== "function") throw err;
      this.log(`[provider] ${this.primary.name}.${String(method)} failed (${(err as Error).message}); using ${this.fallback.name}`);
      return f.apply(this.fallback, args);
    }
  }
}

/** Build the provider stack the environment asks for. */
export function providerFromConfig(cfg: Config): ChainProvider {
  const primary = makeProvider(cfg.primary, cfg);
  if (!cfg.fallback || cfg.fallback === cfg.primary) return primary;
  return FallbackProvider.wrap(primary, makeProvider(cfg.fallback, cfg));
}
