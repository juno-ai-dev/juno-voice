import type { Request, Status } from './types';
export type StatusFilter = 'all' | Status;
export function filterRequests(rows: Request[], status: StatusFilter, search: string): Request[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => (status === 'all' || row.status === status) && (!query || [row.title, row.summary, row.category, row.author, String(row.id)].join(' ').toLocaleLowerCase().includes(query)));
}
