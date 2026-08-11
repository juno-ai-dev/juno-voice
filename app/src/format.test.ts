import { describe, expect, it } from 'vitest';
import { actionLabel, formatJuno, formatTimestamp, netPower } from './format';
import { request } from './test/fixtures';

describe('chain value formatting', () => {
  it('formats minimal-unit amounts losslessly in display units', () => {
    expect(formatJuno('0')).toBe('0 JUNOX');
    expect(formatJuno('1')).toBe('0.000001 JUNOX');
    expect(formatJuno('999999')).toBe('0.999999 JUNOX');
    expect(formatJuno('1000000')).toBe('1 JUNOX');
    expect(formatJuno('1234500')).toBe('1.2345 JUNOX');
    expect(formatJuno('226105793108')).toBe('226,105.793108 JUNOX');
    expect(formatJuno('999999999999999999999999999999')).toBe('999,999,999,999,999,999,999,999.999999 JUNOX');
    expect(formatJuno('-2300000')).toBe('-2.3 JUNOX');
    expect(formatJuno(27_000_000n, { showPositiveSign: true })).toBe('+27 JUNOX');
  });
  it('computes net power exactly and formats nanosecond timestamps', () => {
    expect(netPower(request)).toBe(4000n);
    expect(formatTimestamp('1750000000000000000')).toMatch(/2025/);
  });
  it('labels string and polymorphic action variants', () => {
    expect(actionLabel('submitted')).toBe('submitted');
    expect(actionLabel({ bond_transition: { from: 'locked' } })).toBe('bond transition');
  });
});
