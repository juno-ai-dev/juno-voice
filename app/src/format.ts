import type { Request, Status } from './types';
import { NATIVE_TOKEN } from './denom';

export const statusLabels: Record<Status, string> = { open: 'Open', qualified: 'Qualified', not_prioritized: 'Not prioritized', duplicate: 'Duplicate', spam: 'Spam', building: 'Building', review: 'Review', blocked: 'Blocked', archived: 'Archived', shipped: 'Shipped' };
export function compactAddress(address: string): string { return address.length > 20 ? `${address.slice(0, 11)}…${address.slice(-6)}` : address; }
export function formatJuno(raw: string | bigint, { showPositiveSign = false }: { showPositiveSign?: boolean } = {}): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(NATIVE_TOKEN.decimals);
  const whole = absolute / scale;
  const fractional = (absolute % scale).toString().padStart(NATIVE_TOKEN.decimals, '0').replace(/0+$/, '');
  const sign = value < 0n ? '-' : showPositiveSign ? '+' : '';
  const amount = `${sign}${whole.toLocaleString('en-US')}${fractional ? `.${fractional}` : ''}`;
  return `${amount} ${NATIVE_TOKEN.displayDenom}`;
}
export function netPower(request: Request): bigint { return BigInt(request.support_power) - BigInt(request.oppose_power); }
export function formatTimestamp(raw: string): string {
  const nanos = BigInt(raw);
  return new Date(Number(nanos / 1_000_000n)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function actionLabel(action: Record<string, unknown> | string): string { return typeof action === 'string' ? action : Object.keys(action)[0]?.replaceAll('_', ' ') ?? 'Recorded action'; }
