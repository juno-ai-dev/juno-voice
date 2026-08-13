import { fromBech32 } from "@cosmjs/encoding";

export const PROTOCOL_VERSION = "v2" as const;
export const DEFAULT_CHAIN_ID = "juno-1" as const;
export const DEFAULT_RPC = "https://juno-rpc.publicnode.com:443" as const;
export const DEFAULT_EXPLORER = "https://www.mintscan.io/juno" as const;

export interface AppConfig {
  protocolVersion: typeof PROTOCOL_VERSION;
  chainId: typeof DEFAULT_CHAIN_ID;
  contract: string;
  rpc: string;
  explorer: typeof DEFAULT_EXPLORER;
  codeId: number;
  codeChecksum: string;
  registryContract: string;
  registryCodeId: number;
  registryCodeChecksum: string;
  vaultContract: string;
  vaultCodeId: number;
  vaultCodeChecksum: string;
  votingContract: string;
  votingCodeId: number;
  votingCodeChecksum: string;
  gaugeContract: string;
  gaugeCodeId: number;
  gaugeCodeChecksum: string;
  releaseCommit: string;
}

export interface ConfigEnvironment {
  VITE_PROTOCOL_VERSION?: string;
  VITE_CHAIN_ID?: string;
  VITE_BOUNTY_CONTRACT_ADDRESS?: string;
  VITE_BOUNTY_CODE_ID?: string;
  VITE_BOUNTY_CODE_CHECKSUM?: string;
  VITE_REGISTRY_CONTRACT_ADDRESS?: string;
  VITE_REGISTRY_CODE_ID?: string;
  VITE_REGISTRY_CODE_CHECKSUM?: string;
  VITE_VAULT_CONTRACT_ADDRESS?: string;
  VITE_VAULT_CODE_ID?: string;
  VITE_VAULT_CODE_CHECKSUM?: string;
  VITE_VOTING_CONTRACT_ADDRESS?: string;
  VITE_VOTING_CODE_ID?: string;
  VITE_VOTING_CODE_CHECKSUM?: string;
  VITE_GAUGE_CONTRACT_ADDRESS?: string;
  VITE_GAUGE_CODE_ID?: string;
  VITE_GAUGE_CODE_CHECKSUM?: string;
  VITE_RPC_URL?: string;
  VITE_EXPLORER_URL?: string;
  VITE_RELEASE_COMMIT?: string;
}

function required(env: ConfigEnvironment, key: keyof ConfigEnvironment): string {
  const value = env[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${key}. The fresh v2 deployment identity is incomplete.`);
  return value;
}

function contractAddress(env: ConfigEnvironment, key: keyof ConfigEnvironment, label: string): string {
  const value = required(env, key);
  try {
    const decoded = fromBech32(value);
    if (value !== value.toLowerCase() || decoded.prefix !== "juno" || decoded.data.length !== 32)
      throw new Error();
  } catch {
    throw new Error(`Invalid Juno ${label} contract address. Configuration failed closed.`);
  }
  return value;
}

function codeId(env: ConfigEnvironment, key: keyof ConfigEnvironment, label: string): number {
  const value = required(env, key);
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`Invalid ${label} code ID. Configuration failed closed.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Invalid ${label} code ID. Configuration failed closed.`);
  return parsed;
}

function checksum(env: ConfigEnvironment, key: keyof ConfigEnvironment, label: string): string {
  const value = required(env, key);
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new Error(`Invalid ${label} Wasm checksum. Configuration failed closed.`);
  return value;
}

export function loadConfig(env: ConfigEnvironment = {}): AppConfig {
  if (required(env, "VITE_PROTOCOL_VERSION") !== PROTOCOL_VERSION)
    throw new Error("Unsupported protocol version. Juno Voice requires a verified fresh v2 deployment.");
  const chainId = env.VITE_CHAIN_ID ?? DEFAULT_CHAIN_ID;
  if (chainId !== DEFAULT_CHAIN_ID)
    throw new Error(`Unsupported chain: ${chainId}. Juno Voice is pinned to juno-1.`);

  const contract = contractAddress(env, "VITE_BOUNTY_CONTRACT_ADDRESS", "bounty");
  const registryContract = contractAddress(env, "VITE_REGISTRY_CONTRACT_ADDRESS", "registry");
  const vaultContract = contractAddress(env, "VITE_VAULT_CONTRACT_ADDRESS", "vault");
  const votingContract = contractAddress(env, "VITE_VOTING_CONTRACT_ADDRESS", "voting");
  const gaugeContract = contractAddress(env, "VITE_GAUGE_CONTRACT_ADDRESS", "gauge");
  const addresses = [contract, registryContract, vaultContract, votingContract, gaugeContract];
  if (new Set(addresses).size !== addresses.length)
    throw new Error("V2 component contract addresses must be distinct. Configuration failed closed.");

  const rpc = env.VITE_RPC_URL ?? DEFAULT_RPC;
  const explorer = (env.VITE_EXPLORER_URL ?? DEFAULT_EXPLORER).replace(/\/$/, "");
  const releaseCommit = required(env, "VITE_RELEASE_COMMIT");
  if (releaseCommit !== "local-uncommitted" && !/^[0-9a-f]{40}$/.test(releaseCommit))
    throw new Error("Release commit must be local-uncommitted or a lowercase 40-character Git SHA.");

  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error("Invalid RPC URL. Configuration failed closed.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("RPC URL must be a credential-free HTTPS endpoint.");
  if (explorer !== DEFAULT_EXPLORER)
    throw new Error("Unsupported explorer URL. Configuration failed closed.");

  return {
    protocolVersion: PROTOCOL_VERSION,
    chainId,
    contract,
    rpc: url.toString().replace(/\/$/, ""),
    explorer,
    codeId: codeId(env, "VITE_BOUNTY_CODE_ID", "bounty"),
    codeChecksum: checksum(env, "VITE_BOUNTY_CODE_CHECKSUM", "bounty"),
    registryContract,
    registryCodeId: codeId(env, "VITE_REGISTRY_CODE_ID", "registry"),
    registryCodeChecksum: checksum(env, "VITE_REGISTRY_CODE_CHECKSUM", "registry"),
    vaultContract,
    vaultCodeId: codeId(env, "VITE_VAULT_CODE_ID", "vault"),
    vaultCodeChecksum: checksum(env, "VITE_VAULT_CODE_CHECKSUM", "vault"),
    votingContract,
    votingCodeId: codeId(env, "VITE_VOTING_CODE_ID", "voting"),
    votingCodeChecksum: checksum(env, "VITE_VOTING_CODE_CHECKSUM", "voting"),
    gaugeContract,
    gaugeCodeId: codeId(env, "VITE_GAUGE_CODE_ID", "gauge"),
    gaugeCodeChecksum: checksum(env, "VITE_GAUGE_CODE_CHECKSUM", "gauge"),
    releaseCommit,
  };
}
