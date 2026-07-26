import { fromBech32 } from '@cosmjs/encoding';

export const DEFAULT_CHAIN_ID = 'uni-7' as const;
export const DEFAULT_CONTRACT = 'juno1t7ajx85pkw8e0yl8vgnlxvnlq4yf0h6a3eahuystnf6e9jfhwvvsv4jcel' as const;
export const DEFAULT_RPC = 'https://juno-testnet-rpc.cogwheel.zone' as const;
export const CODE_ID = 85 as const;
export const CODE_CHECKSUM = 'fd264e53ae9af64231b8e62aff0da099e0ff21ba38d887c7a96d9c4ef755a96e' as const;
export const DEFAULT_EXPLORER = 'https://www.mintscan.io/juno-testnet' as const;

export interface AppConfig { chainId: typeof DEFAULT_CHAIN_ID; contract: typeof DEFAULT_CONTRACT; rpc: string; explorer: typeof DEFAULT_EXPLORER; codeId: typeof CODE_ID; codeChecksum: typeof CODE_CHECKSUM }
export interface ConfigEnvironment { VITE_CHAIN_ID?: string; VITE_CONTRACT_ADDRESS?: string; VITE_RPC_URL?: string; VITE_EXPLORER_URL?: string }

export function loadConfig(env: ConfigEnvironment = {}): AppConfig {
  const chainId = env.VITE_CHAIN_ID ?? DEFAULT_CHAIN_ID;
  const contract = env.VITE_CONTRACT_ADDRESS ?? DEFAULT_CONTRACT;
  const rpc = env.VITE_RPC_URL ?? DEFAULT_RPC;
  const explorer = env.VITE_EXPLORER_URL ?? DEFAULT_EXPLORER;
  if (chainId !== DEFAULT_CHAIN_ID) throw new Error(`Unsupported chain: ${chainId}. Juno Voice is pinned to uni-7.`);
  try {
    const decoded = fromBech32(contract);
    if (decoded.prefix !== 'juno' || decoded.data.length !== 32) throw new Error('invalid prefix or length');
  } catch { throw new Error('Invalid Juno contract address. Configuration failed closed.'); }
  if (contract !== DEFAULT_CONTRACT) throw new Error(`Unsupported contract: ${contract}. Juno Voice fails closed to the verified uni-7 deployment.`);
  let url: URL;
  try { url = new URL(rpc); } catch { throw new Error('Invalid RPC URL. Configuration failed closed.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('RPC URL must be a credential-free HTTPS endpoint.');
  }
  if (explorer.replace(/\/$/, '') !== DEFAULT_EXPLORER) throw new Error('Unsupported explorer URL. Configuration failed closed.');
  return { chainId, contract, rpc: url.toString().replace(/\/$/, ''), explorer: DEFAULT_EXPLORER, codeId: CODE_ID, codeChecksum: CODE_CHECKSUM };
}
