import { expect, test, type Page, type Route } from "@playwright/test";
import {
  QueryCodeResponse,
  QueryContractInfoResponse,
  QuerySmartContractStateRequest,
  QuerySmartContractStateResponse,
} from "cosmjs-types/cosmwasm/wasm/v1/query.js";
import fixture from "../src/test/live-mainnet-empty.json" with { type: "json" };

const rpc = "https://rpc.cosmos.directory/juno";
const projectPath = "/juno-voice/";
const releaseCommit = process.env.PLAYWRIGHT_RELEASE_COMMIT;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function gotoDeployableArtifact(page: Page) {
  const criticalTypes = ["script", "stylesheet", "image"];
  const responses = new Map(criticalTypes.map((type) => [type, [] as number[]]));
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (
      criticalTypes.includes(type) &&
      new URL(response.url()).pathname.startsWith(projectPath)
    )
      responses.get(type)?.push(response.status());
  });

  await page.goto(projectPath);
  await expect(page.locator("img")).toHaveCount(2);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  for (const type of criticalTypes) {
    const statuses = responses.get(type) ?? [];
    expect(statuses, `${type} assets must be requested`).not.toHaveLength(0);
    expect(statuses.every((status) => status >= 200 && status < 400)).toBe(true);
  }
}

function result(value: Uint8Array) {
  return {
    result: { response: { code: 0, log: "", value: Buffer.from(value).toString("base64") } },
  };
}

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockMainnet(page: Page, options: { failures?: number; chain?: string } = {}) {
  let failures = options.failures ?? 0;
  let requests = 0;
  await page.route(`${rpc}/**`, async (route) => {
    requests += 1;
    if (failures > 0) {
      failures -= 1;
      await fulfill(route, { error: "temporary failure" }, 503);
      return;
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) {
      await fulfill(route, {
        result: {
          node_info: { network: options.chain ?? fixture.provenance.chain_id },
          sync_info: { latest_block_height: String(fixture.provenance.observation_height) },
        },
      });
      return;
    }
    const path = url.searchParams.get("path") ?? "";
    if (path.includes("ContractInfo")) {
      const bytes = QueryContractInfoResponse.encode(
        QueryContractInfoResponse.fromPartial({
          address: fixture.provenance.contract_address,
          contractInfo: { codeId: BigInt(fixture.provenance.code_id) },
        }),
      ).finish();
      await fulfill(route, result(bytes));
      return;
    }
    if (path.endsWith("/Code\"")) {
      const bytes = QueryCodeResponse.encode(
        QueryCodeResponse.fromPartial({
          codeInfo: {
            codeId: BigInt(fixture.provenance.code_id),
            dataHash: Buffer.from(fixture.provenance.checksum, "hex"),
          },
        }),
      ).finish();
      await fulfill(route, result(bytes));
      return;
    }
    if (path.includes("SmartContractState")) {
      const hex = (url.searchParams.get("data") ?? "0x").replace(/^0x/, "");
      const request = QuerySmartContractStateRequest.decode(Buffer.from(hex, "hex"));
      const query = JSON.parse(decoder.decode(request.queryData)) as Record<string, unknown>;
      const key = Object.keys(query)[0] as keyof typeof fixture.responses;
      const bytes = QuerySmartContractStateResponse.encode({
        data: encoder.encode(JSON.stringify(fixture.responses[key])),
      }).finish();
      await fulfill(route, result(bytes));
      return;
    }
    await fulfill(route, { error: `unexpected RPC path: ${path}` }, 500);
  });
  return { requests: () => requests };
}

test("configured juno-1 artifact proves provenance and renders authoritative live-empty state", async ({ page }) => {
  await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  await expect(page.getByText("No sample or demo records are shown.")).toBeVisible();
  await expect(page.getByText("juno-1", { exact: true })).toBeVisible();
  await expect(page.getByText("5150", { exact: true })).toBeVisible();
  await expect(page.getByText("40,681,635", { exact: true })).toBeVisible();
  await expect(
    page.getByText((releaseCommit ?? "").slice(0, 12) + "…", { exact: true }),
  ).toBeVisible();
});

test("freshness changes to stale in an open browser", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-12T12:00:00Z") });
  await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await expect(page.getByText("Fresh direct-RPC observation")).toBeVisible();
  await page.clock.fastForward(60_002);
  await expect(page.getByText("Stale · retry recommended")).toBeVisible();
});

test("RPC errors are explicit and retry recovers", async ({ page }) => {
  await mockMainnet(page, { failures: 1 });
  await gotoDeployableArtifact(page);
  await expect(page.getByText("Mainnet data unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry query" }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
});

test("provenance mismatch fails closed", async ({ page }) => {
  await mockMainnet(page, { chain: "uni-7" });
  await gotoDeployableArtifact(page);
  await expect(page.getByText(/expected chain juno-1, observed uni-7/)).toBeVisible();
});

test("hard refresh performs a new direct-RPC observation", async ({ page }) => {
  const observed = await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  const first = observed.requests();
  await page.reload();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  expect(observed.requests()).toBeGreaterThan(first);
});
