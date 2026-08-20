import { useId, useRef, useState } from "react";
import { digestMetadataFile } from "./metadataDigest";
import "./uri-digest-fields.css";

// The manual URI + SHA-256 fingerprint pair used wherever a metadata reference
// can be supplied by hand. The file picker only hashes locally; nothing is
// uploaded from this component.
export function UriDigestFields({ uriName, uriLabel, uriAriaLabel, uriHint, uriPlaceholder, uriType, uriValue, onUriChange,
  digestName, digestLabel, digestAriaLabel, digestHint, digestValue, onDigestChange, digestWide,
  fileLabel, fileAriaLabel, fileHint, disabled, onHashingChange }: {
  uriName?: string; uriLabel: string; uriAriaLabel?: string; uriHint: string; uriPlaceholder?: string;
  uriType?: "text" | "url"; uriValue?: string; onUriChange?: (value: string) => void;
  digestName?: string; digestLabel: string; digestAriaLabel?: string; digestHint: string;
  digestValue?: string; onDigestChange?: (value: string) => void; digestWide?: boolean;
  fileLabel: string; fileAriaLabel?: string; fileHint?: string;
  disabled?: boolean; onHashingChange?: (busy: boolean) => void;
}) {
  const [internalDigest, setInternalDigest] = useState("");
  const digestControlled = digestValue !== undefined;
  const digest = digestControlled ? digestValue : internalDigest;
  const [hashStatus, setHashStatus] = useState("");
  const [hashing, setHashing] = useState(false);
  const hashGeneration = useRef(0);
  const uriHintId = useId();
  const digestHintId = useId();
  const setDigest = (value: string) => { onDigestChange?.(value); if (!digestControlled) setInternalDigest(value); };
  const setBusy = (busy: boolean) => { setHashing(busy); onHashingChange?.(busy); };
  const hashFile = async (file?: File) => {
    const generation = ++hashGeneration.current;
    if (!file) return setHashStatus("");
    setBusy(true);
    setHashStatus(`Calculating SHA-256 for ${file.name}…`);
    try {
      const value = await digestMetadataFile(file);
      if (generation !== hashGeneration.current) return;
      setDigest(value);
      setHashStatus(`Digest calculated locally from ${file.name}. The file was not uploaded.`);
    } catch (cause) {
      if (generation !== hashGeneration.current) return;
      setHashStatus(cause instanceof Error ? cause.message : "This file could not be hashed. Paste a verified digest instead.");
    } finally {
      if (generation === hashGeneration.current) setBusy(false);
    }
  };
  return <>
    <label className="uri-field">{uriLabel}<span className="field-hint" id={uriHintId}>{uriHint}</span>
      <input name={uriName} type={uriType ?? "text"} aria-label={uriAriaLabel} aria-describedby={uriHintId}
        placeholder={uriPlaceholder ?? "ipfs://… or https://…"} value={uriValue} disabled={disabled}
        onChange={onUriChange ? (event) => onUriChange(event.target.value) : undefined} spellCheck={false} autoComplete="off" />
    </label>
    <div className={digestWide ? "hash-field wide" : "hash-field"}>
      <label>{digestLabel}<span className="field-hint" id={digestHintId}>{digestHint}</span>
        <input name={digestName} aria-label={digestAriaLabel} aria-describedby={digestHintId} value={digest}
          onChange={(event) => { hashGeneration.current += 1; setDigest(event.target.value); setHashStatus(""); }}
          pattern="sha256:[0-9a-f]{64}" maxLength={71} placeholder="sha256:…" spellCheck={false} autoComplete="off"
          disabled={disabled || hashing} />
      </label>
      <label className="file-picker">{fileLabel}
        <input type="file" aria-label={fileAriaLabel} disabled={disabled || hashing}
          onChange={(event) => void hashFile(event.target.files?.[0])} />
      </label>
      {fileHint && <small className="field-hint">{fileHint}</small>}
      {hashStatus && <small className="hash-status" role="status">{hashStatus}</small>}
    </div>
  </>;
}
