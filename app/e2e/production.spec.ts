import { expect, test, type Page, type Route } from "@playwright/test";
import {
  QueryCodeRequest,
  QueryCodeResponse,
  QueryContractInfoRequest,
  QueryContractInfoResponse,
  QuerySmartContractStateRequest,
  QuerySmartContractStateResponse,
} from "cosmjs-types/cosmwasm/wasm/v1/query.js";
import { QueryBalanceResponse } from "cosmjs-types/cosmos/bank/v1beta1/query.js";
import fixture from "../src/test/live-mainnet-empty.json" with { type: "json" };

const rpc = "https://juno-rpc.publicnode.com:443";
const projectPath = "/juno-voice/";
const releaseCommit = process.env.PLAYWRIGHT_RELEASE_COMMIT;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const deployments = {
  "juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw": [5150, "f05e9eaf3f90c7a5273bea3e8db8ff570b4f9192a4032472865cd4293b49bce1"],
  "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n": [5151, "1edaf206f87958e3be62225c2cdb71345b39ca07f16b74005c463bbf7c1debbf"],
  "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg": [5152, "bc8b049a03496d3383376a469ccb581996238003532083895f68d4a02990a2da"],
  "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2": [5153, "2f336e39f9c05ad57c972eb3a51ce58ba0afaeb5944ff337d68e67644f1dad64"],
  "juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn": [5154, "524d5728994950bccb471ed586d2726f3594157fafccd484aa3c0c3012e8794f"],
} as const;

function captureBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()} (${message.location().url})`);
  });
  return () => expect(errors, "page and console errors").toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, `content width at ${dimensions.viewport}px`).toBeLessThanOrEqual(
    dimensions.viewport,
  );
}

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
          sync_info: {
            latest_block_height: String(fixture.provenance.observation_height),
            latest_block_time: "2026-08-12T12:00:00Z",
          },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/block")) {
      await fulfill(route, { result: { block: { header: { time: "2026-08-12T12:00:00.123456789Z" } } } });
      return;
    }
    const path = url.searchParams.get("path") ?? "";
    if (path.includes("ContractInfo")) {
      const hex = (url.searchParams.get("data") ?? "0x").replace(/^0x/, "");
      const request = QueryContractInfoRequest.decode(Buffer.from(hex, "hex"));
      const deployment = deployments[request.address as keyof typeof deployments] ?? [fixture.provenance.code_id, fixture.provenance.checksum];
      const bytes = QueryContractInfoResponse.encode(
        QueryContractInfoResponse.fromPartial({
          address: request.address,
          contractInfo: { codeId: BigInt(deployment[0]) },
        }),
      ).finish();
      await fulfill(route, result(bytes));
      return;
    }
    if (path.endsWith("/Code\"")) {
      const hex = (url.searchParams.get("data") ?? "0x").replace(/^0x/, "");
      const request = QueryCodeRequest.decode(Buffer.from(hex, "hex"));
      const checksum = Object.values(deployments).find(([id]) => BigInt(id) === request.codeId)?.[1] ?? fixture.provenance.checksum;
      const bytes = QueryCodeResponse.encode(
        QueryCodeResponse.fromPartial({
          codeInfo: {
            codeId: request.codeId,
            dataHash: Buffer.from(checksum, "hex"),
          },
        }),
      ).finish();
      await fulfill(route, result(bytes));
      return;
    }
    if (path.includes("cosmos.bank.v1beta1.Query/Balance")) {
      const bytes = QueryBalanceResponse.encode({ balance: { denom: "ujuno", amount: "0" } }).finish();
      await fulfill(route, result(bytes)); return;
    }
    if (path.includes("SmartContractState")) {
      const hex = (url.searchParams.get("data") ?? "0x").replace(/^0x/, "");
      const request = QuerySmartContractStateRequest.decode(Buffer.from(hex, "hex"));
      const query = JSON.parse(decoder.decode(request.queryData)) as Record<string, unknown>;
      const key = Object.keys(query)[0];
      let response: unknown = key in fixture.responses ? fixture.responses[key as keyof typeof fixture.responses] : undefined;
      if (request.address === "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg") response = key === "voting_module" ? "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2" : [{ address: "juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn", prefix: "A", status: "enabled" }];
      if (request.address === "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2") response = "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg";
      if (request.address === "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n") {
        if (key === "config") response = { native_denom: "ujuno", registration_bond: "1000000", max_active_projects: 99, max_metadata_uri_bytes: 512, max_page_limit: 50, max_reason_bytes: 500, payout_address_delay_seconds: 86400, curator: "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac", governor: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", version: 1 };
        else if (key === "pause") response = { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null };
        else if (key === "health") response = { accounting: { active_projects: 0, pending_applications: 0, bond_liability: "0", lifetime_bonds_received: "0", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" }, actual_native_balance: "0", fully_backed: true };
        else if (key === "projects" || key === "applications") response = { projects: [] };
        else if (key === "all_options") response = { options: ["do-not-distribute"] };
      }
      if (request.address === "juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn") {
        if (key === "config") response = { owner: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", dao_core: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", voting_powers: "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2", hook_caller: "juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn", power_source: { epoch_snapshot: { guardian: "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac" } } };
        if (key === "gauge") response = { id: 0, title: "Hack Juno", adapter: "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n", epoch_size: 604800, min_percent_selected: "0.01", max_options_selected: 20, max_available_percentage: "0.2", is_stopped: false, next_epoch: 0, reset: null, snapshot_policy: { min_turnout_bps: 1000, epoch_budget: "100000000", denom: "ujuno" }, current_epoch: null };
        if (key === "list_epochs") response = { epochs: [] };
      }
      const bytes = QuerySmartContractStateResponse.encode({
        data: encoder.encode(JSON.stringify(response)),
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("Fresh direct-RPC observation")).toBeVisible();
  await page.clock.fastForward(60_002);
  await expect(page.getByText("Stale · retry recommended")).toBeVisible();
});

test("RPC errors are explicit and retry recovers", async ({ page }) => {
  await mockMainnet(page, { failures: 1 });
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("Mainnet data unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry query" }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
});

test("provenance mismatch fails closed", async ({ page }) => {
  await mockMainnet(page, { chain: "uni-7" });
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
  await expect(page.getByText(/expected chain juno-1, observed uni-7/)).toBeVisible();
});

test("hard refresh performs a new direct-RPC observation", async ({ page }) => {
  const observed = await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  const first = observed.requests();
  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  expect(observed.requests()).toBeGreaterThan(first);
});

test("gauge route verifies the full deployment and renders live-empty safety semantics", async ({ page }) => {
  await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Gauge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weighted allocation" })).toBeVisible();
  await expect(page.getByText("No epoch has opened")).toBeVisible();
  await page.getByText("How retained value and fixed options work").click();
  await expect(page.getByText(/Nothing shown here implies an automatic rollover/)).toBeVisible();
  await page.getByRole("button", { name: "Open voting workbench" }).click();
  await expect(page.getByText(/transaction support is unavailable in this browser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare open epoch" })).toHaveCount(0);
});

test("footer opens the dedicated FAQ and the logo returns home", async ({ page }) => {
  await mockMainnet(page);
  await gotoDeployableArtifact(page);

  await expect(page.getByText("NEW TO JUNO VOICE?")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: /^FAQ/ }).click();
  await expect(page).toHaveURL(/#faq$/);
  await expect(page.getByRole("heading", { name: /Questions, answered plainly/ })).toBeVisible();
  await page.getByText("What is a project candidate?").click();
  await expect(page.getByText(/does not register, endorse, approve, or automatically graduate/)).toBeVisible();
  await page.getByRole("link", { name: "Juno VOICE" }).click();
  await expect(page.getByRole("heading", { name: /Fund useful work/ })).toBeVisible();
});

test("mobile public routes do not overflow or emit browser errors", async ({ page }) => {
  const expectNoBrowserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await mockMainnet(page);
  await gotoDeployableArtifact(page);

  await expect(page.getByRole("heading", { name: /Fund useful work/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Bounties", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Public bounty ledger" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Gauge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weighted allocation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Eligible projects" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expectNoBrowserErrors();
});

test("keyboard reaches primary navigation and the public retry action", async ({ page }) => {
  await mockMainnet(page, { failures: 1 });
  await gotoDeployableArtifact(page);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Juno VOICE" })).toBeFocused();
  const primaryNavigation = page.getByRole("navigation", { name: "Primary" });
  for (const name of ["Bounties"]) {
    await page.keyboard.press("Tab");
    await expect(primaryNavigation.getByRole("button", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page.getByText("Mainnet data unavailable")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Retry query" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
});
