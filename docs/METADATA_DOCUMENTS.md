# Juno Voice metadata documents

This document defines the JSON documents referenced by the URI + SHA-256 digest
pairs that Juno Voice contracts store on chain. It is the normative spec for
wallets, frontends, explorers, and indexers that write or render this metadata.
The executable form of these rules lives in `app/src/metadataDocuments.ts`.

This spec layers **above** the frozen contract interface described in
`UX_CONTRACT_INTERFACE_FREEZE.md`. On chain there is only an opaque URI string
and a `sha256:<64 lowercase hex>` digest; nothing here changes any message or
state shape. Contracts never fetch or verify document content. The digest lets
any reader prove that a fetched document is exactly the one the author
committed to.

## Where these documents are referenced

| On-chain field(s) | Contract | Document type |
|---|---|---|
| `Project.metadata_uri` / `metadata_digest` | hack-juno-registry-adapter (`RegisterProject`, `UpdatePendingMetadata`, `Graduate`) | `juno-voice/project` |
| `project_candidate.metadata_uri` / `metadata_digest` | juno-voice-bounties (`CreateBounty`) | `juno-voice/project` |
| `Terms.content_uri` / `content_digest` | juno-voice-bounties (`CreateBounty`) | `juno-voice/bounty-content` |
| `Nomination.evidence_uri` / `evidence_digest` | juno-voice-bounties (`NominatePayout`) | `juno-voice/evidence` |

A bounty's project candidate is forwarded byte-for-byte into the registry's
`Graduate` message, so candidate metadata and registry project metadata are the
same document type by construction.

## Shared envelope

Every document is a single JSON object with two required fields:

| Field | Type | Rule |
|---|---|---|
| `doc` | string | Exactly one of `"juno-voice/project"`, `"juno-voice/bounty-content"`, `"juno-voice/evidence"`. |
| `version` | integer | `1`. Readers must reject unknown `doc` values. A `version` greater than 1 means the document is newer than the reader understands: render a fallback, never guess. |

General rules:

- Text fields must not contain control characters. Multiline fields
  (`description`, `brief`, `acceptance_details`, `summary` in evidence) may
  contain newlines and tabs.
- URLs are limited to 512 UTF-8 bytes. `https://` links may point anywhere;
  `ipfs://` links use a CID (CIDv1 recommended).
- A canonical document must serialize to at most 16,384 bytes. Readers should
  refuse to fetch documents larger than 65,536 bytes.

## `juno-voice/project`

Describes a project for the registry and for gauge voters. `name` and `summary`
are what voters see, so keep them plain and truthful. Names and slugs are
non-unique presentation metadata; canonical identity is the numeric project ID
(see architecture decision 005).

| Field | Required | Rule |
|---|---|---|
| `name` | yes | 1–120 characters, single line. A short name people will recognize. |
| `summary` | yes | 1–280 characters, single line. What the project does, in one or two sentences. |
| `slug` | no | Lowercase letters and digits separated by single hyphens, at most 40 characters. |
| `description` | no | Up to 4,000 characters, multiline plain text. |
| `website` | no | `https://` URL. |
| `repository` | no | `https://` URL. |
| `logo` | no | `ipfs://` URI of a separately pinned image. PNG, JPEG, or WebP, at most 524,288 bytes. |
| `tags` | no | 1–8 unique tags, each matching `[a-z0-9-]{1,24}`. |
| `links` | no | 1–8 entries of `{ "label": <1–40 chars>, "url": <https:// or ipfs://> }`. |

Example:

```json
{
  "doc": "juno-voice/project",
  "version": 1,
  "name": "Juno Voice",
  "summary": "Community bounties, gauge funding, and a public project registry on Juno.",
  "slug": "juno-voice",
  "repository": "https://github.com/example/juno-voice",
  "tags": ["tooling", "governance"]
}
```

## `juno-voice/bounty-content`

The long-form brief behind a bounty. The bounty's title, summary, and
acceptance criteria already live on chain as plain fields; this document
carries the detail that does not fit there.

| Field | Required | Rule |
|---|---|---|
| `brief` | yes | 1–8,000 characters, multiline. The full specification of the work. |
| `deliverables` | no | 1–20 entries, each 1–280 characters, single line. |
| `acceptance_details` | no | Up to 4,000 characters, multiline. Expands the on-chain acceptance criteria. |
| `links` | no | Same shape and limits as project `links`. |

## `juno-voice/evidence`

Attached to a payout nomination: what was delivered and where reviewers can
verify it.

| Field | Required | Rule |
|---|---|---|
| `summary` | yes | 1–2,000 characters, multiline. What was delivered. |
| `items` | yes | 1–20 entries. |
| `items[].kind` | yes | One of `pull_request`, `commit`, `release`, `deployment`, `document`, `test_report`, `other`. |
| `items[].url` | yes | `https://` or `ipfs://`, at most 512 bytes. |
| `items[].note` | no | 1–280 characters, single line. |

## Canonical serialization (writers)

The on-chain digest binds exact bytes, so writers must serialize
deterministically:

- UTF-8, compact JSON: no insignificant whitespace.
- Object keys sorted lexicographically at every depth.
- Strings normalized to Unicode NFC before serialization.
- Numbers restricted to safe integers (only `version` is a number in v1).
- No trailing newline, no byte-order mark.
- The digest is `sha256:` followed by the lowercase hex SHA-256 of exactly the
  serialized bytes. Hash the same byte buffer you publish; never re-serialize
  between hashing and publishing.

## Verification (readers)

Readers never re-canonicalize. Hash the exact fetched bytes, compare against
the on-chain digest, and only then parse:

- **Verified**: bytes hash to the on-chain digest and the document validates.
  Safe to render.
- **Mismatch**: bytes hash differently. Do not render any content from the
  document; show a warning instead.
- **Invalid**: the digest matches but the JSON does not validate against this
  spec. Show the raw link and digest only.

A hand-written document verifies as long as its published bytes match its
committed digest; canonical serialization is a determinism guarantee for
writers, not a read-side requirement.

Render document text as plain text. This spec deliberately contains no HTML or
markdown fields.
