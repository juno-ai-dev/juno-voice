# Pinata presign worker

A ~120-line Cloudflare Worker that lets the Juno Voice app upload metadata
documents to IPFS without ever holding a Pinata credential in the browser. The
worker owns the Pinata admin JWT and issues short-lived signed upload URLs; the
browser uploads directly to Pinata with the signed URL.

This code ships with the repository, but **deployment is an operator-gated
action**, consistent with the project's release policy: no public frontend is
released today, and this worker should only be deployed alongside an authorized
frontend release.

## Contract with the app

- `POST /sign` with JSON `{ "kind": "document" | "image", "filename": string, "size": integer, "content_type": string }`.
- `200 { "url": "<signed Pinata upload URL>" }` — the browser then POSTs
  multipart form data (`file`, `network=public`) to that URL with no
  authorization header.
- `400` invalid body · `403` origin not allowed · `413` size over the per-kind
  cap · `502` pinning-service failure (the upstream body is never echoed).

Caps are enforced by Pinata through the sign options, so a leaked signed URL is
still bounded: documents `application/json` ≤ 16,384 bytes; images
`image/png`/`image/jpeg`/`image/webp` ≤ 524,288 bytes. Signed URLs expire after
60 seconds.

## Deploy (operator runbook)

1. Create a dedicated Pinata account (or key) for Juno Voice. Generate a JWT
   with upload permission only. Optionally create a Pinata group and note its
   ID — group-scoped pins make cleanup of orphaned documents practical.
2. `cd infra/pinata-presign-worker`
3. `node --test` — the unit tests must pass.
4. Set the browser origins that may request signed URLs (exact match,
   comma-separated) in `wrangler.toml` under `[vars] ALLOWED_ORIGINS`, or via
   the dashboard.
5. `npx wrangler secret put PINATA_JWT`
6. Optional: `npx wrangler secret put PINATA_GROUP_ID` (or set as a var).
7. `npx wrangler deploy`
8. **Add a Cloudflare rate-limiting rule** for the worker route (for example,
   30 requests per minute per IP on `/sign`). The worker is stateless by design
   and does not rate-limit itself.
9. Configure the frontend build with `VITE_PRESIGN_URL=https://<worker-host>/sign`.

Note: the exact Pinata v3 sign-request field names (`date`, `expires`,
`filename`, `network`, `max_file_size`, `allow_mime_types`, `group_id`) should
be re-checked against the current Pinata docs at deploy time. The app↔worker
contract above is what the frontend depends on; Pinata drift is absorbed here.

## Local development

- `npx wrangler dev` with a personal Pinata JWT
  (`ALLOWED_ORIGINS=http://localhost:5173` and `PINATA_JWT` in `.dev.vars`),
  then run the app with `VITE_PRESIGN_URL=http://127.0.0.1:8787/sign`.
- Or leave `VITE_PRESIGN_URL` unset: the app hides the upload flow and offers
  the manual link-a-published-file mode only. Automated tests never need the
  worker; they mock fetch and Playwright routes.

## Teardown

`npx wrangler delete` and revoke the Pinata JWT. Pinned content remains on
Pinata until unpinned; if a group ID was used, list and unpin via the group.
