import { describe, expect, it, vi } from 'vitest';
import { createDataSource, mapRankedResponse, mapRequestResponse, queries } from './client';
import { config, ledger, request } from './test/fixtures';

describe('canonical direct-RPC queries', () => {
  it('constructs exact schema-authoritative JSON messages with bounded pages', () => {
    expect(queries.requests()).toEqual({ requests: { status: null, category: null, author: null, start_after_id: null, limit: 50 } });
    expect(queries.rankedRequests(2, 'cursor')).toEqual({ ranked_requests: { status: 2, category: null, cursor: 'cursor', limit: 50 } });
    expect(queries.request(7)).toEqual({ request: { id: 7 } });
    expect(queries.evidence(7)).toEqual({ evidence: { request_id: 7, start_after_id: null, limit: 50 } });
    expect(queries.statusHistory(7)).toEqual({ status_history: { request_id: 7, start_after_id: null, limit: 50 } });
    expect(queries.requestActions(7)).toEqual({ request_actions: { request_id: 7, start_after_id: null, limit: 50 } });
    expect(queries.shipmentAttestation(7)).toEqual({ shipment_attestation: { request_id: 7 } });
  });
  it('rejects Uint64 overflow before timestamps can reach rendering', () => {
    expect(() => mapRequestResponse({ request: { ...request, created_at: '18446744073709551616' } })).toThrow(/Malformed request/);
  });
  it('maps a realistic ranked response and rejects malformed RPC data', () => {
    expect(mapRankedResponse({ items: [request], next_cursor: 'next', query_height: 1500 })).toEqual({ items: [request], next_cursor: 'next', query_height: 1500 });
    expect(() => mapRankedResponse({ items: {}, query_height: 'bad' })).toThrow(/Malformed/);
  });
  it('queries and maps ledger responses from one direct client', async () => {
    const responses = new Map([
      [JSON.stringify(queries.config()), { config: ledger.config }],
      [JSON.stringify(queries.bondTotals()), { totals: { locked: '1', refundable: '2', forfeited: '3' } }],
      [JSON.stringify(queries.requests()), { items: [request], next_start_after: null, query_height: 1499 }],
    ]);
    const rpc = {
      queryContractSmart: vi.fn((_address: string, message: object) => {
        if ('ranked_requests' in message) return Promise.resolve({ items: [], next_cursor: null, query_height: 1499 });
        return Promise.resolve(responses.get(JSON.stringify(message)));
      }),
      getChainId: vi.fn().mockResolvedValue('uni-7'),
      getHeight: vi.fn().mockResolvedValue(1500),
      getContract: vi.fn().mockResolvedValue({ address: config.contract, codeId: 85 }),
      getCodeDetails: vi.fn().mockResolvedValue({ checksum: config.codeChecksum }),
      disconnect: vi.fn(),
    };
    const result = await createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger();
    expect(result.requests[0].title).toBe('Real RPC feature');
    expect(result.queryHeight).toBe(1499);
    expect(rpc.queryContractSmart).toHaveBeenCalledWith(config.contract, queries.requests());
    expect(rpc.disconnect).toHaveBeenCalled();
  });
  it('continues through empty intermediate ID and opaque ranked cursor pages', async () => {
    const rpc = {
      queryContractSmart: vi.fn((_address: string, message: Record<string, unknown>) => {
        if ('config' in message) return Promise.resolve({ config: ledger.config });
        if ('bond_totals' in message) return Promise.resolve({ totals: ledger.bonds });
        if ('requests' in message) {
          const cursor = (message.requests as { start_after_id: number | null }).start_after_id;
          return Promise.resolve(cursor === null ? { items: [], next_start_after: 7, query_height: 1499 } : { items: [request], next_start_after: null, query_height: 1498 });
        }
        const ranked = message.ranked_requests as { status: number; cursor: string | null };
        if (ranked.status === 2 && ranked.cursor === null) return Promise.resolve({ items: [], next_cursor: 'opaque', query_height: 1497 });
        if (ranked.status === 2) return Promise.resolve({ items: [request], next_cursor: null, query_height: 1496 });
        return Promise.resolve({ items: [], next_cursor: null, query_height: 1497 });
      }),
      getChainId: vi.fn().mockResolvedValue('uni-7'), getHeight: vi.fn().mockResolvedValue(1500),
      getContract: vi.fn().mockResolvedValue({ address: config.contract, codeId: 85 }), getCodeDetails: vi.fn().mockResolvedValue({ checksum: config.codeChecksum }), disconnect: vi.fn(),
    };
    const result = await createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger();
    expect(result.requests).toHaveLength(1);
    expect(result.ranked.qualified).toHaveLength(1);
    expect(result.queryHeight).toBe(1496);
  });
  it('fails closed when the connected chain does not match the deployment', async () => {
    const rpc = {
      queryContractSmart: vi.fn(),
      getChainId: vi.fn().mockResolvedValue('juno-1'),
      getHeight: vi.fn(),
      getContract: vi.fn().mockResolvedValue({ address: config.contract, codeId: 85 }),
      getCodeDetails: vi.fn(),
      disconnect: vi.fn(),
    };
    await expect(createDataSource(config, vi.fn().mockResolvedValue(rpc)).loadLedger()).rejects.toThrow(/Deployment mismatch/);
    expect(rpc.queryContractSmart).not.toHaveBeenCalled();
    expect(rpc.disconnect).toHaveBeenCalled();
  });
});
