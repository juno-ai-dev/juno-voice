import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Detail } from './Detail';
import { config, detail, ledger } from './test/fixtures';

describe('real request detail', () => {
  it('renders immutable facts, evidence, history, actions, bond, and absent attestation', async () => {
    render(<Detail id={7} config={config} source={{ loadLedger: vi.fn().mockResolvedValue(ledger), loadDetail: vi.fn().mockResolvedValue(detail) }} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Real RPC feature' })).toBeInTheDocument();
    expect(screen.getByText('Observable acceptance from chain')).toBeInTheDocument();
    expect(screen.getByText('Threshold reached')).toBeInTheDocument();
    expect(screen.getByText('finalized')).toBeInTheDocument();
    expect(screen.getByText('Tests passed')).toBeInTheDocument();
    expect(screen.getByText('No shipment attestation recorded.')).toBeInTheDocument();
    expect(screen.getByText(/Wallet transactions and signing/)).toBeInTheDocument();
  });
  it('renders unsafe detail URIs as text rather than links', async () => {
    const unsafe = { ...detail, request: { ...detail.request, detail_uri: 'javascript:alert(1)' } };
    render(<Detail id={7} config={config} source={{ loadLedger: vi.fn(), loadDetail: vi.fn().mockResolvedValue(unsafe) }} onBack={vi.fn()} />);
    expect(await screen.findByText(/javascript:alert/)).not.toHaveAttribute('href');
  });
  it('preserves primary request facts when a child query fails', async () => {
    const partial = { ...detail, evidence: [], sectionErrors: { evidence: 'RPC unavailable' } };
    render(<Detail id={7} config={config} source={{ loadLedger: vi.fn(), loadDetail: vi.fn().mockResolvedValue(partial) }} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Real RPC feature' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Could not load evidence: RPC unavailable');
  });
});
