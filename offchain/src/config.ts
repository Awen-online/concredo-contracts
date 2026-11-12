// Runtime configuration, read from environment variables (and offchain/.env if present).
// Nothing secret has a default. See offchain/.env.example for every variable.

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const OFFCHAIN_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(OFFCHAIN_ROOT, "..");
loadDotenv({ path: path.join(OFFCHAIN_ROOT, ".env"), quiet: true });

/** The wallet folder. CONCREDO_KEYS_DIR points at another checkout's keys/ (for example a git worktree). */
export const KEYS_DIR = process.env.CONCREDO_KEYS_DIR ?? path.join(REPO_ROOT, "keys");
export const BLUEPRINT_PATH = path.join(REPO_ROOT, "contracts", "plutus.json");

export type ProviderName = "koios" | "blockfrost" | "kupmios";
export type NetworkName = "Preprod" | "Preview" | "Mainnet";

const PROVIDERS: readonly ProviderName[] = ["koios", "blockfrost", "kupmios"];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function providerName(name: string, fallback?: ProviderName): ProviderName | undefined {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === "none") return undefined;
  if (!(PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`${name}=${raw} is not one of ${PROVIDERS.join(", ")}, none`);
  }
  return raw as ProviderName;
}

export interface Config {
  network: NetworkName;
  primary: ProviderName;
  fallback?: ProviderName;
  koios: { url: string; token?: string };
  blockfrost: { url: string; projectId?: string };
  kupmios: { kupoUrl?: string; ogmiosUrl?: string };
}

export function loadConfig(): Config {
  const network = (env("CARDANO_NETWORK") ?? "Preprod") as NetworkName;
  if (network === "Mainnet") {
    throw new Error("This scaffold refuses Mainnet. Set CARDANO_NETWORK=Preprod.");
  }
  const lower = network.toLowerCase();
  return {
    network,
    // Koios needs no key, so the scaffold works out of the box.
    primary: providerName("CARDANO_PROVIDER", "koios")!,
    fallback: providerName("CARDANO_PROVIDER_FALLBACK"),
    koios: {
      url: env("KOIOS_URL") ?? `https://${lower}.koios.rest/api/v1`,
      token: env("KOIOS_TOKEN"),
    },
    blockfrost: {
      url: env("BLOCKFROST_URL") ?? `https://cardano-${lower}.blockfrost.io/api/v0`,
      projectId: env("BLOCKFROST_PROJECT_ID"),
    },
    kupmios: {
      kupoUrl: env("KUPO_URL"),
      ogmiosUrl: env("OGMIOS_URL"),
    },
  };
}
