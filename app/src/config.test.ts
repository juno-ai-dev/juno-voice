import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACT, loadConfig } from './config';

describe('fail-closed live configuration', () => {
  it('uses only the pinned uni-7 defaults', () => expect(loadConfig()).toMatchObject({ chainId: 'uni-7', contract: DEFAULT_CONTRACT, codeId: 85 }));
  it('rejects a wrong chain', () => expect(() => loadConfig({ VITE_CHAIN_ID: 'juno-1' })).toThrow(/Unsupported chain/));
  it('rejects malformed or wrong-prefix contracts', () => {
    expect(() => loadConfig({ VITE_CONTRACT_ADDRESS: 'not-an-address' })).toThrow(/Invalid Juno contract/);
    expect(() => loadConfig({ VITE_CONTRACT_ADDRESS: 'cosmos1t7ajx85pkw8e0yl8vgnlxvnlq4yf0h6a3eahuystnf6e9jfhwvvsv4jcel' })).toThrow(/Invalid Juno contract/);
  });
  it('rejects unsafe and malformed RPC URLs', () => {
    expect(() => loadConfig({ VITE_RPC_URL: 'not a url' })).toThrow(/Invalid RPC/);
    expect(() => loadConfig({ VITE_RPC_URL: 'http://rpc.example' })).toThrow(/credential-free HTTPS/);
    expect(() => loadConfig({ VITE_RPC_URL: 'https://user:pass@rpc.example' })).toThrow(/credential-free HTTPS/);
  });
});
