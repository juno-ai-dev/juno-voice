import { useEffect, useState } from "react";
import type { MetadataDocKind } from "./metadataDocuments";
import type { MetadataClient, VerifiedMetadata } from "./metadataFetch";

export type MetadataViewState = VerifiedMetadata | { state: "loading" } | { state: "absent" };

// Without a client (tests, or metadata support disabled) the state is a stable
// "absent" and callers render their URI fallback. Results are keyed to the
// request they answered, so switching references shows "loading", never a
// stale document.
export function useVerifiedMetadata(
  client: MetadataClient | undefined,
  uri: string | null | undefined,
  digest: string | null | undefined,
  expected: MetadataDocKind,
): MetadataViewState {
  const key = `${expected}\n${digest ?? ""}\n${uri ?? ""}`;
  const [result, setResult] = useState<{ key: string; value: VerifiedMetadata } | null>(null);
  useEffect(() => {
    if (!client || !uri || !digest) return;
    let cancelled = false;
    const requestKey = `${expected}\n${digest}\n${uri}`;
    void client.load(uri, digest, expected).then((value) => {
      if (!cancelled) setResult({ key: requestKey, value });
    });
    return () => { cancelled = true; };
  }, [client, uri, digest, expected]);
  if (!client || !uri || !digest) return { state: "absent" };
  return result && result.key === key ? result.value : { state: "loading" };
}
