import { describe, expect, it } from 'vitest';
import { actionLabel, formatPower, formatTimestamp, netPower } from './format';
import { request } from './test/fixtures';

describe('chain value formatting', () => {
  it('keeps powers lossless and formats nanosecond timestamps', () => {
    expect(formatPower('226105793108')).toBe('226,105,793,108');
    expect(formatPower('999999999999999999999999999999')).toBe('999,999,999,999,999,999,999,999,999,999');
    expect(netPower(request)).toBe(4000n);
    expect(formatTimestamp('1750000000000000000')).toMatch(/2025/);
  });
  it('labels string and polymorphic action variants', () => {
    expect(actionLabel('submitted')).toBe('submitted');
    expect(actionLabel({ bond_transition: { from: 'locked' } })).toBe('bond transition');
  });
});
