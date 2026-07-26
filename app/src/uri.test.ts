import { describe, expect, it } from 'vitest';
import { safeUri } from './uri';

describe('safe URI policy', () => {
  it('allows HTTP(S) and maps IPFS explicitly through a gateway', () => {
    expect(safeUri('https://example.com/proof')?.href).toBe('https://example.com/proof');
    expect(safeUri('http://example.com/proof')?.kind).toBe('web');
    expect(safeUri('ipfs://bafyproof/readme')).toEqual({ href: 'https://ipfs.io/ipfs/bafyproof/readme', label: 'ipfs://bafyproof/readme', kind: 'ipfs' });
  });
  it.each(['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', 'ipfs:', 'not a uri'])('does not link %s', (uri) => expect(safeUri(uri)).toBeNull());
});
