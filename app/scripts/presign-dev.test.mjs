import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DEV_GATEWAY_PATH,
  DEV_UPLOAD_PATH,
  PRESIGN_PATH,
  base32Lower,
  createMemoryPinStore,
  createOfflineEndpoint,
  createPinataEndpoint,
  createPresignDev,
  rawCidV1,
} from "./presign-dev.mjs";

const ORIGIN = "http://localhost:5173";
const document = (body) => new TextEncoder().encode(JSON.stringify(body));

const sign = (payload) =>
  new Request(`${ORIGIN}${PRESIGN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(payload),
  });

const upload = (url, bytes, contentType, filename = "document.json") => {
  const form = new FormData();
  form.append("network", "public");
  form.append("file", new File([bytes], filename, { type: contentType }));
  return new Request(`${ORIGIN}${url}`, { method: "POST", headers: { origin: ORIGIN }, body: form });
};

// Decodes base32 independently of the encoder under test, so the CID assertion
// checks the real multihash bytes rather than restating the implementation.
function decodeBase32(text) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bits = [...text].map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  return Uint8Array.from(bytes);
}

test("rawCidV1 encodes a CIDv1 raw sha2-256 multihash", () => {
  const bytes = new TextEncoder().encode("hello juno");
  const cid = rawCidV1(bytes);
  assert.match(cid, /^bafkrei[a-z2-7]+$/);
  assert.match(cid, /^baf[a-z2-7]{50,}$/, "must satisfy the app's CID pattern");
  const decoded = decodeBase32(cid.slice(1));
  assert.deepEqual([...decoded.slice(0, 4)], [0x01, 0x55, 0x12, 0x20], "version, raw codec, sha2-256, length");
  assert.equal(Buffer.from(decoded.slice(4)).toString("hex"), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(base32Lower(new Uint8Array([0])), "aa");
});

test("offline endpoint signs, pins, and serves the exact bytes back", async () => {
  const handle = createOfflineEndpoint({ store: createMemoryPinStore() });
  const bytes = document({ doc: "juno-voice/project", name: "Test", summary: "A project", version: 1 });

  const signed = await handle(sign({ kind: "document", filename: "project.json", size: bytes.length, content_type: "application/json" }));
  assert.equal(signed.status, 200);
  const { url } = await signed.json();
  assert.ok(url.startsWith(`${DEV_UPLOAD_PATH}?token=`), "signed URL must be a same-origin path");

  const uploaded = await handle(upload(url, bytes, "application/json"));
  assert.equal(uploaded.status, 200);
  const { data } = await uploaded.json();
  assert.equal(data.cid, rawCidV1(bytes));

  const fetched = await handle(new Request(`${ORIGIN}${DEV_GATEWAY_PATH}/${data.cid}`));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "application/json");
  const served = new Uint8Array(await fetched.arrayBuffer());
  assert.deepEqual([...served], [...bytes], "the gateway must return byte-identical content so the digest verifies");
});

test("offline endpoint enforces the signed request, single use, and expiry", async () => {
  let clock = 1_000;
  const handle = createOfflineEndpoint({ store: createMemoryPinStore(), now: () => clock });
  const bytes = document({ doc: "juno-voice/project", version: 1 });

  const oversize = await handle(sign({ kind: "document", filename: "big.json", size: 20_000, content_type: "application/json" }));
  assert.equal(oversize.status, 413);
  const wrongType = await handle(sign({ kind: "document", filename: "doc.json", size: 10, content_type: "text/html" }));
  assert.equal(wrongType.status, 400);

  const { url } = await (await handle(sign({ kind: "document", filename: "doc.json", size: bytes.length, content_type: "application/json" }))).json();
  const mismatched = await handle(upload(url, document({ doc: "juno-voice/project", version: 1, extra: "longer" }), "application/json"));
  assert.equal(mismatched.status, 400, "uploaded bytes must match the signed size");
  const reused = await handle(upload(url, bytes, "application/json"));
  assert.equal(reused.status, 403, "a signed URL is single use");

  const fresh = await (await handle(sign({ kind: "document", filename: "doc.json", size: bytes.length, content_type: "application/json" }))).json();
  clock += 61_000;
  assert.equal((await handle(upload(fresh.url, bytes, "application/json"))).status, 403, "signed URLs expire");

  const missing = await handle(new Request(`${ORIGIN}${DEV_GATEWAY_PATH}/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`));
  assert.equal(missing.status, 404);
  const traversal = await handle(new Request(`${ORIGIN}${DEV_GATEWAY_PATH}/..%2F..%2Fpackage.json`));
  assert.equal(traversal.status, 400);
  assert.equal(await handle(new Request(`${ORIGIN}/api/dev-ipfs/other`)), null, "unrelated paths fall through");
});

test("offline endpoint refuses cross-origin callers", async () => {
  const handle = createOfflineEndpoint({ store: createMemoryPinStore() });
  const foreign = new Request(`${ORIGIN}${PRESIGN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ kind: "document", filename: "doc.json", size: 2, content_type: "application/json" }),
  });
  assert.equal((await handle(foreign)).status, 403);
});

test("pinata mode delegates to the deployed worker with the dev origin allowlisted", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { url: "https://uploads.pinata.cloud/v3/files/signed" } }), { status: 200 });
  };
  const handle = createPinataEndpoint({ jwt: "test-jwt", groupId: "group-1", fetcher });
  const response = await handle(sign({ kind: "image", filename: "logo.png", size: 1_024, content_type: "image/png" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://uploads.pinata.cloud/v3/files/signed" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer test-jwt");
  assert.equal(calls[0].body.max_file_size, 524_288);
  assert.equal(calls[0].body.group_id, "group-1");
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN, "the dev server is its own allowlist");
});

test("createPresignDev attaches only to a dev server, and picks the mode from the environment", () => {
  const offline = createPresignDev({ command: "serve", mode: "development", env: {} });
  assert.equal(offline.mode, "offline");
  assert.equal(offline.env.VITE_PRESIGN_URL, PRESIGN_PATH);
  assert.equal(offline.env.VITE_IPFS_GATEWAY, DEV_GATEWAY_PATH);
  assert.ok(offline.plugin);
  assert.equal(offline.plugin.apply, "serve");

  const pinata = createPresignDev({ command: "serve", mode: "development", env: { PINATA_JWT: "jwt" } });
  assert.equal(pinata.mode, "pinata");
  assert.equal(pinata.env.VITE_PRESIGN_URL, PRESIGN_PATH);
  assert.equal(pinata.env.VITE_IPFS_GATEWAY, undefined, "real pins resolve through the real gateway");

  const configuredGateway = createPresignDev({ command: "serve", mode: "development", env: { VITE_IPFS_GATEWAY: "https://gateway.example/ipfs" } });
  assert.equal(configuredGateway.env.VITE_IPFS_GATEWAY, undefined, "an explicit gateway is never overridden");

  // .env.example spells out the default gateway, so copied env files set it
  // without choosing it. Offline mode must still use its own gateway.
  const defaulted = createPresignDev({ command: "serve", mode: "development", env: { VITE_IPFS_GATEWAY: "https://ipfs.io/ipfs/" } });
  assert.equal(defaulted.env.VITE_IPFS_GATEWAY, DEV_GATEWAY_PATH);

  for (const disabled of [
    createPresignDev({ command: "build", mode: "production", env: {} }),
    createPresignDev({ command: "serve", mode: "production", isPreview: true, env: {} }),
    createPresignDev({ command: "serve", mode: "test", env: {} }),
    createPresignDev({ command: "serve", mode: "development", env: { VITEST: "true" } }),
    createPresignDev({ command: "serve", mode: "development", env: { VITE_PRESIGN_URL: "https://presign.example/sign" } }),
  ]) {
    assert.equal(disabled.mode, "disabled");
    assert.equal(disabled.plugin, null);
    assert.deepEqual(disabled.env, {});
  }
});
