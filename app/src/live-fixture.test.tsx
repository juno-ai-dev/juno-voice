import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDataSource, queries } from './client';
import { Detail } from './Detail';
import { config, ledger } from './test/fixtures';
import live from './test/live-request-1.json';

describe('captured uni-7 request #1 regression fixture', () => {
  it('passes the real response through deployment checks, validators, and detail rendering', async () => {
    const responses = new Map<string, unknown>([
      [JSON.stringify(queries.config()), { config: ledger.config }],
      [JSON.stringify(queries.request(1)), live.request],
      [JSON.stringify(queries.evidence(1)), live.evidence],
      [JSON.stringify(queries.statusHistory(1)), live.history],
      [JSON.stringify(queries.requestActions(1)), live.actions],
      [JSON.stringify(queries.shipmentAttestation(1)), live.attestation],
    ]);
    const rpc = {
      queryContractSmart: vi.fn((_address: string, message: object) => Promise.resolve(responses.get(JSON.stringify(message)))),
      getChainId: vi.fn().mockResolvedValue('uni-7'), getHeight: vi.fn().mockResolvedValue(16_177_000),
      getContract: vi.fn().mockResolvedValue({ address: config.contract, codeId: 85 }),
      getCodeDetails: vi.fn().mockResolvedValue({ checksum: config.codeChecksum }), disconnect: vi.fn(),
    };
    const source = createDataSource(config, vi.fn().mockResolvedValue(rpc));
    const result = await source.loadDetail(1);
    expect(result.request.status).toBe('shipped');
    expect(result.evidence).toHaveLength(2);
    expect(result.history).toHaveLength(4);
    expect(result.actions).toHaveLength(13);
    expect(result.attestation).not.toBeNull();

    render(<Detail id={1} config={config} source={{ loadLedger: vi.fn(), loadDetail: vi.fn().mockResolvedValue(result) }} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: live.request.request.title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shipment attestation' })).toBeInTheDocument();
    expect(screen.getAllByRole('time').length).toBeGreaterThan(10);
    expect(screen.getByText('27 JUNOX')).toBeInTheDocument();
    expect(screen.getByText('226,105.793108 JUNOX')).toBeInTheDocument();
  });
});
