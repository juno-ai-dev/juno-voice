import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { Ledger } from './Ledger';
import { config, detail, ledger } from './test/fixtures';

const source = { loadLedger: vi.fn().mockResolvedValue(ledger), loadDetail: vi.fn().mockResolvedValue(detail) };

describe('accessibility smoke', () => {
  it('has no detectable serious or critical ledger violations', async () => {
    const { container } = render(<Ledger source={source} config={config} onOpen={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Signal ledger' });
    const results = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
  });
});
