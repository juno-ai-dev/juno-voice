import type { Request, Status } from './types';

export const statusLabels: Record<Status, string> = { open: 'Open', qualified: 'Qualified', not_prioritized: 'Not prioritized', duplicate: 'Duplicate', spam: 'Spam', building: 'Building', review: 'Review', blocked: 'Blocked', archived: 'Archived', shipped: 'Shipped' };
export function compactAddress(address: string): string { return address.length > 20 ? `${address.slice(0, 11)}…${address.slice(-6)}` : address; }
export function formatPower(raw: string): string { try { return BigInt(raw).toLocaleString('en-US'); } catch { return raw; } }
export function netPower(request: Request): bigint { return BigInt(request.support_power) - BigInt(request.oppose_power); }
export function formatTimestamp(raw: string): string {
  const nanos = BigInt(raw);
  return new Date(Number(nanos / 1_000_000n)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function actionLabel(action: Record<string, unknown> | string): string { return typeof action === 'string' ? action : Object.keys(action)[0]?.replaceAll('_', ' ') ?? 'Recorded action'; }
