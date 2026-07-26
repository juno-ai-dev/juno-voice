export interface SafeUri { href: string; label: string; kind: 'web' | 'ipfs' }
export function safeUri(raw: string): SafeUri | null {
  try {
    const uri = new URL(raw);
    if (uri.protocol === 'https:' || uri.protocol === 'http:') return { href: uri.href, label: raw, kind: 'web' };
    if (uri.protocol === 'ipfs:' && uri.hostname && !uri.username && !uri.password && !uri.port && !uri.search && !uri.hash) {
      const path = `${uri.hostname}${uri.pathname}`;
      return { href: `https://ipfs.io/ipfs/${path}`, label: raw, kind: 'ipfs' };
    }
  } catch { return null; }
  return null;
}
