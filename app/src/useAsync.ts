import { useCallback, useEffect, useState } from 'react';

export type AsyncState<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T };
export function useAsync<T>(load: () => Promise<T>, key: string | number): [AsyncState<T>, () => void] {
  const [revision, setRevision] = useState(0);
  const token = `${key}:${revision}`;
  const [result, setResult] = useState<{ token: string; state: AsyncState<T> }>({ token, state: { kind: 'loading' } });
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    load().then((data) => { if (active) setResult({ token, state: { kind: 'ready', data } }); }, (error: unknown) => {
      if (active) setResult({ token, state: { kind: 'error', message: error instanceof Error ? error.message : 'Unknown RPC error' } });
    });
    return () => { active = false; };
  }, [token, load]);
  return [result.token === token ? result.state : { kind: 'loading' }, retry];
}
