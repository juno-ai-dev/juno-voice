import { describe, expect, it } from 'vitest';
import { filterRequests } from './filter';
import { request } from './test/fixtures';

describe('ledger filters', () => {
  const other = { ...request, id: 8, title: 'Wallet adapter', summary: 'Later work', category: 'wallet', status: 'open' as const };
  it('filters status and searches loaded real fields case-insensitively', () => {
    expect(filterRequests([request, other], 'qualified', '')).toEqual([request]);
    expect(filterRequests([request, other], 'all', 'INFRASTRUCTURE')).toEqual([request]);
    expect(filterRequests([request, other], 'all', 'juno1author')).toHaveLength(2);
  });
});
