import type { ProjectFieldsValue } from "./metadataForms";

// Structured project details shared by the registry workbench and the bounty
// project-candidate section — they must produce the same document type because
// a candidate becomes the registry record verbatim on graduation.
export function ProjectFields({ value, onChange, disabled }: {
  value: ProjectFieldsValue;
  onChange: (next: ProjectFieldsValue) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ProjectFieldsValue>) => onChange({ ...value, ...patch });
  return <>
    <label>Project name<span className="field-hint">A short name people will recognize · up to 120 characters</span>
      <input value={value.name} maxLength={120} disabled={disabled} onChange={(event) => set({ name: event.target.value })} />
    </label>
    <label>Short summary<span className="field-hint">What the project does, in one or two sentences · up to 280 characters</span>
      <input value={value.summary} maxLength={280} disabled={disabled} onChange={(event) => set({ summary: event.target.value })} />
    </label>
    <label className="wide">Description<span className="field-hint">Optional longer description, plain text.</span>
      <textarea value={value.description} disabled={disabled} onChange={(event) => set({ description: event.target.value })} />
    </label>
    <label>Website<span className="field-hint">Optional HTTPS link.</span>
      <input value={value.website} type="url" placeholder="https://…" disabled={disabled} onChange={(event) => set({ website: event.target.value })} />
    </label>
    <label>Code repository<span className="field-hint">Optional HTTPS link.</span>
      <input value={value.repository} type="url" placeholder="https://…" disabled={disabled} onChange={(event) => set({ repository: event.target.value })} />
    </label>
    <label>Tags<span className="field-hint">Optional, separated by spaces or commas. Lowercase letters, digits, and hyphens.</span>
      <input value={value.tags} placeholder="tooling governance" disabled={disabled} onChange={(event) => set({ tags: event.target.value })} />
    </label>
    <label className="file-picker">Choose a logo image
      <input type="file" aria-label="Choose a logo image" accept="image/png,image/jpeg,image/webp" disabled={disabled}
        onChange={(event) => set({ logo: event.target.files?.[0] ?? null })} />
    </label>
    {value.logo && <small className="field-hint">Logo selected: {value.logo.name}. PNG, JPEG, or WebP up to 512 KB; published to IPFS with the project details.</small>}
  </>;
}
