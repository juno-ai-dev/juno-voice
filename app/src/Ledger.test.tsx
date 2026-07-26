import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Ledger } from './Ledger';
import { config, ledger } from './test/fixtures';

describe('live ledger states', () => {
  it('renders loading then real response data, chain facts, and freshness', async () => {
    let resolve!: (value: typeof ledger) => void;
    const loadLedger = vi.fn(() => new Promise<typeof ledger>((done) => { resolve = done; }));
    render(<Ledger config={config} source={{ loadLedger, loadDetail: vi.fn() }} onOpen={vi.fn()} />);
    expect(screen.getByText(/Receiving uni-7 signal/)).toBeInTheDocument();
    resolve({ ...ledger, refreshedAt: new Date() });
    expect(await screen.findByText('Real RPC feature')).toBeInTheDocument();
    expect(screen.getByText('Fresh direct-RPC data')).toBeInTheDocument();
    expect(screen.getAllByText('uni-7').length).toBeGreaterThan(0);
    expect(screen.getByText('85')).toBeInTheDocument();
  });
  it('renders stale and search-filtered states', async () => {
    const source = { loadLedger: vi.fn().mockResolvedValue({ ...ledger, refreshedAt: new Date(0) }), loadDetail: vi.fn() };
    render(<Ledger config={config} source={source} onOpen={vi.fn()} />);
    expect(await screen.findByText('Real RPC feature')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'does-not-exist');
    expect(screen.getByText('No matching signal')).toBeInTheDocument();
    expect(screen.getByText(/Stale/)).toBeInTheDocument();
  });
  it('renders an authoritative empty contract state', async () => {
    const ranked = Object.fromEntries(Object.keys(ledger.ranked).map((key) => [key, []])) as unknown as typeof ledger.ranked;
    const source = { loadLedger: vi.fn().mockResolvedValue({ ...ledger, requests: [], ranked }), loadDetail: vi.fn() };
    render(<Ledger config={config} source={source} onOpen={vi.fn()} />);
    expect(await screen.findByText('No on-chain requests yet')).toBeInTheDocument();
  });
  it('shows RPC error and retries', async () => {
    const loadLedger = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue({ ...ledger, refreshedAt: new Date() });
    render(<Ledger config={config} source={{ loadLedger, loadDetail: vi.fn() }} onOpen={vi.fn()} />);
    expect(await screen.findByText('connection refused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry query' }));
    expect(await screen.findByText('Real RPC feature')).toBeInTheDocument();
    expect(loadLedger).toHaveBeenCalledTimes(2);
  });
});
