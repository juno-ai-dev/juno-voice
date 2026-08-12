import { fromBech32 } from "@cosmjs/encoding";

export const DEFAULT_CHAIN_ID = "juno-1" as const;
export const DEFAULT_BOUNTY_CONTRACT =
  "juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw" as const;
export const DEFAULT_CONTRACT = DEFAULT_BOUNTY_CONTRACT;
export const DEFAULT_RPC = "https://rpc.cosmos.directory/juno" as const;
export const DEFAULT_EXPLORER = "https://www.mintscan.io/juno" as const;
export const CODE_ID = 5150 as const;
export const CODE_CHECKSUM =
  "f05e9eaf3f90c7a5273bea3e8db8ff570b4f9192a4032472865cd4293b49bce1" as const;
export const DEFAULT_REGISTRY_CONTRACT =
  "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n" as const;
export const REGISTRY_CODE_ID = 5151 as const;
export const REGISTRY_CODE_CHECKSUM =
  "1edaf206f87958e3be62225c2cdb71345b39ca07f16b74005c463bbf7c1debbf" as const;

export interface AppConfig {
  chainId: typeof DEFAULT_CHAIN_ID;
  contract: typeof DEFAULT_BOUNTY_CONTRACT;
  rpc: string;
  explorer: typeof DEFAULT_EXPLORER;
  codeId: typeof CODE_ID;
  codeChecksum: typeof CODE_CHECKSUM;
  registryContract: typeof DEFAULT_REGISTRY_CONTRACT;
  registryCodeId: typeof REGISTRY_CODE_ID;
  registryCodeChecksum: typeof REGISTRY_CODE_CHECKSUM;
  releaseCommit: string;
}
export interface ConfigEnvironment {
  VITE_CHAIN_ID?: string;
  VITE_BOUNTY_CONTRACT_ADDRESS?: string;
  VITE_RPC_URL?: string;
  VITE_EXPLORER_URL?: string;
  VITE_RELEASE_COMMIT?: string;
}
export function loadConfig(env: ConfigEnvironment = {}): AppConfig {
  const chainId = env.VITE_CHAIN_ID ?? DEFAULT_CHAIN_ID;
  const contract = env.VITE_BOUNTY_CONTRACT_ADDRESS ?? DEFAULT_BOUNTY_CONTRACT;
  const rpc = env.VITE_RPC_URL ?? DEFAULT_RPC;
  const explorer = (env.VITE_EXPLORER_URL ?? DEFAULT_EXPLORER).replace(
    /\/$/,
    "",
  );
  const releaseCommit = env.VITE_RELEASE_COMMIT ?? "local-uncommitted";
  if (
    releaseCommit !== "local-uncommitted" &&
    !/^[0-9a-f]{40}$/.test(releaseCommit)
  )
    throw new Error("Release commit must be a lowercase 40-character Git SHA.");
  if (chainId !== DEFAULT_CHAIN_ID)
    throw new Error(
      `Unsupported chain: ${chainId}. Juno Voice is pinned to juno-1.`,
    );
  try {
    const decoded = fromBech32(contract);
    if (decoded.prefix !== "juno" || decoded.data.length !== 32)
      throw new Error();
  } catch {
    throw new Error(
      "Invalid Juno bounty contract address. Configuration failed closed.",
    );
  }
  if (contract !== DEFAULT_BOUNTY_CONTRACT)
    throw new Error(
      `Unsupported bounty contract: ${contract}. Juno Voice fails closed to the verified juno-1 deployment.`,
    );
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error("Invalid RPC URL. Configuration failed closed.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("RPC URL must be a credential-free HTTPS endpoint.");
  if (explorer !== DEFAULT_EXPLORER)
    throw new Error("Unsupported explorer URL. Configuration failed closed.");
  return {
    chainId,
    contract,
    rpc: url.toString().replace(/\/$/, ""),
    explorer,
    codeId: CODE_ID,
    codeChecksum: CODE_CHECKSUM,
    registryContract: DEFAULT_REGISTRY_CONTRACT,
    registryCodeId: REGISTRY_CODE_ID,
    registryCodeChecksum: REGISTRY_CODE_CHECKSUM,
    releaseCommit,
  };
}
