import assert from "node:assert/strict";
import test from "node:test";
import { allowedOrigin, handleRequest, KINDS, validateSignRequest } from "./worker.mjs";

const env = { PINATA_JWT: "test-jwt", ALLOWED_ORIGINS: "https://app.example, https://other.example" };
const signBody = { kind: "document", filename: "project.json", size: 100, content_type: "application/json" };
const postRequest = (body, origin = "https://app.example") =>
  new Request("https://worker.example/sign", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const pinataOk = async () => new Response(JSON.stringify({ data: "https://uploads.pinata.cloud/v3/files/signed-token" }), { status: 200 });

test("origin allowlist matches exactly", () => {
  const request = (origin) => new Request("https://worker.example/sign", { headers: origin ? { origin } : {} });
  assert.equal(allowedOrigin(request("https://app.example"), env), "https://app.example");
  assert.equal(allowedOrigin(request("https://other.example"), env), "https://other.example");
  assert.equal(allowedOrigin(request("https://evil.example"), env), null);
  assert.equal(allowedOrigin(request("https://app.example.evil"), env), null);
  assert.equal(allowedOrigin(request(null), env), null);
  assert.equal(allowedOrigin(request("https://app.example"), {}), null);
});

test("sign request validation enforces kind, filename, size, and MIME caps", () => {
  assert.deepEqual(validateSignRequest(signBody), { kind: "document", filename: "project.json", size: 100, contentType: "application/json" });
  assert.equal(validateSignRequest({ ...signBody, filename: "../a b/c.json" }).filename, "a-b-c.json");
  assert.equal(validateSignRequest({ ...signBody, filename: "///" }).filename, "upload");
  assert.equal(validateSignRequest(null).status, 400);
  assert.equal(validateSignRequest({ ...signBody, kind: "video" }).status, 400);
  assert.equal(validateSignRequest({ ...signBody, filename: "" }).status, 400);
  assert.equal(validateSignRequest({ ...signBody, filename: "x".repeat(129) }).status, 400);
  assert.equal(validateSignRequest({ ...signBody, size: 0 }).status, 400);
  assert.equal(validateSignRequest({ ...signBody, size: KINDS.document.maxBytes + 1 }).status, 413);
  assert.equal(validateSignRequest({ ...signBody, content_type: "text/html" }).status, 400);
  assert.equal(validateSignRequest({ kind: "image", filename: "logo.png", size: KINDS.image.maxBytes, content_type: "image/png" }).kind, "image");
  assert.equal(validateSignRequest({ kind: "image", filename: "logo.png", size: KINDS.image.maxBytes + 1, content_type: "image/png" }).status, 413);
});

test("happy path returns the signed URL and caps come from the kind", async () => {
  let upstreamBody;
  const fetcher = async (url, init) => {
    assert.equal(url, "https://uploads.pinata.cloud/v3/files/sign");
    assert.equal(init.headers.authorization, "Bearer test-jwt");
    upstreamBody = JSON.parse(init.body);
    return pinataOk();
  };
  const response = await handleRequest(postRequest(signBody), env, fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://uploads.pinata.cloud/v3/files/signed-token" });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(upstreamBody.expires, 60);
  assert.equal(upstreamBody.network, "public");
  assert.equal(upstreamBody.max_file_size, KINDS.document.maxBytes);
  assert.deepEqual(upstreamBody.allow_mime_types, ["application/json"]);
  assert.equal(upstreamBody.group_id, undefined);
});

test("group id is forwarded when configured", async () => {
  let upstreamBody;
  const fetcher = async (_url, init) => { upstreamBody = JSON.parse(init.body); return pinataOk(); };
  await handleRequest(postRequest(signBody), { ...env, PINATA_GROUP_ID: "group-1" }, fetcher);
  assert.equal(upstreamBody.group_id, "group-1");
});

test("disallowed origins, bad routes, and preflight are handled", async () => {
  const fetcher = async () => { throw new Error("must not be called"); };
  assert.equal((await handleRequest(postRequest(signBody, "https://evil.example"), env, fetcher)).status, 403);
  const preflightAllowed = await handleRequest(new Request("https://worker.example/sign", { method: "OPTIONS", headers: { origin: "https://app.example" } }), env, fetcher);
  assert.equal(preflightAllowed.status, 204);
  const preflightBlocked = await handleRequest(new Request("https://worker.example/sign", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env, fetcher);
  assert.equal(preflightBlocked.status, 403);
  const wrongPath = await handleRequest(new Request("https://worker.example/other", { method: "POST", headers: { origin: "https://app.example" } }), env, fetcher);
  assert.equal(wrongPath.status, 404);
});

test("upstream failures map to 502 without echoing the upstream body", async () => {
  const rejected = await handleRequest(postRequest(signBody), env, async () => new Response("secret account details", { status: 401 }));
  assert.equal(rejected.status, 502);
  assert.match((await rejected.json()).error, /rejected/);
  const unreachable = await handleRequest(postRequest(signBody), env, async () => { throw new Error("network"); });
  assert.equal(unreachable.status, 502);
  const malformed = await handleRequest(postRequest(signBody), env, async () => new Response("not json", { status: 200 }));
  assert.equal(malformed.status, 502);
  const wrongHost = await handleRequest(postRequest(signBody), env, async () => new Response(JSON.stringify({ data: "https://evil.example/x" }), { status: 200 }));
  assert.equal(wrongHost.status, 502);
});
