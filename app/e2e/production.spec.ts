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
import fixture from "../src/test/v2-empty-state.json" with { type: "json" };
import { TEST_DEPLOYMENT_ENV } from "../src/test/deployment";

const rpc = TEST_DEPLOYMENT_ENV.VITE_RPC_URL;
const projectPath = "/juno-voice/";
const releaseCommit = process.env.PLAYWRIGHT_RELEASE_COMMIT;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const deployments = {
  "juno1r4j8cpvd4e0t8p2hgyvnk5q2s2y8dpqd99ltymtkq99qq2j40waqph80dh": [5155, "2d8265a9ce58d1057da3cea3b06c80d8dd89acf066e44073dd09008b3cd44ffa"],
  "juno1f55krdtt936k9d5vel043gpe4axqyq7ysgk59j25ev0lxlzwkvxqsswx4t": [5156, "513aa9264013e29c18007a85818ccfdbb1f3c4177d58cb4e13d9af3ae9d42a6a"],
  "juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt": [5157, "3600206880f8f24ab867aac6b17b844b16a7b58712c5ca336a076bc13c98f2c0"],
  "juno1w0spzqef0ypkv8v56jwmvewju63xarn5x6v3wy0wee49yu6r9z6s6a35sr": [5158, "1a08d78f7364ba461253a6cf71ea00d35600906a065d49702bd87ba210adacb4"],
  "juno1cprm2juuadkrx9rpy73arxgrugqkzx4d20uvpj5ww49cnp6sndcqyz525v": [5159, "b38915a07a79104768d37b109bb7c21517441a21802fec2b7a49c3fde4ae813d"],
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

async function mockMainnet(page: Page, options: { failures?: number; chain?: string; registryProjects?: unknown[] } = {}) {
  let failures = options.failures ?? 0;
  let requests = 0;
  // The metadata read side is pointed at a fixed fake gateway host by
  // TEST_DEPLOYMENT_ENV; abort by default so no test leaks to a live network.
  // Tests that need documents register a more specific route afterwards.
  await page.route("https://ipfs-gateway.test/**", (route) => route.abort());
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
      if (request.address === "juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt") response = key === "voting_module" ? "juno1w0spzqef0ypkv8v56jwmvewju63xarn5x6v3wy0wee49yu6r9z6s6a35sr" : [{ address: "juno1cprm2juuadkrx9rpy73arxgrugqkzx4d20uvpj5ww49cnp6sndcqyz525v", prefix: "A", status: "enabled" }];
      if (request.address === "juno1w0spzqef0ypkv8v56jwmvewju63xarn5x6v3wy0wee49yu6r9z6s6a35sr") response = "juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt";
      if (request.address === "juno1f55krdtt936k9d5vel043gpe4axqyq7ysgk59j25ev0lxlzwkvxqsswx4t") {
        if (key === "config") response = { native_denom: "ujuno", registration_bond: "100000000", max_active_projects: 99, max_metadata_uri_bytes: 512, max_page_limit: 100, max_reason_bytes: 2048, payout_address_delay_seconds: 86400, curator: "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac", governor: "juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt", version: 1 };
        else if (key === "pause") response = { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null };
        else if (key === "health") response = { accounting: { active_projects: 0, pending_applications: 0, bond_liability: "0", lifetime_bonds_received: "0", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" }, actual_native_balance: "0", fully_backed: true };
        else if (key === "projects") response = { projects: options.registryProjects ?? [] };
        else if (key === "applications") response = { projects: [] };
        else if (key === "all_options") response = { options: ["do-not-distribute",
          ...(options.registryProjects ?? []).map((project) => `project:${(project as { id: number }).id}`)].sort() };
      }
      if (request.address === "juno1cprm2juuadkrx9rpy73arxgrugqkzx4d20uvpj5ww49cnp6sndcqyz525v") {
        if (key === "config") response = { owner: "juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt", dao_core: "juno178famzzydmmyuqteu5g0vdhkrw53r6zatud5ap55xn7a95jeakssqjh8wt", voting_powers: "juno1w0spzqef0ypkv8v56jwmvewju63xarn5x6v3wy0wee49yu6r9z6s6a35sr", hook_caller: "juno1cprm2juuadkrx9rpy73arxgrugqkzx4d20uvpj5ww49cnp6sndcqyz525v", power_source: { epoch_snapshot: { guardian: "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac" } } };
        if (key === "gauge") response = { id: 0, title: "Hack Juno weekly allocation", adapter: "juno1f55krdtt936k9d5vel043gpe4axqyq7ysgk59j25ev0lxlzwkvxqsswx4t", epoch_size: 604800, min_percent_selected: "0.01", max_options_selected: 20, max_available_percentage: "0.2", is_stopped: false, next_epoch: 0, reset: null, snapshot_policy: { min_turnout_bps: 100, epoch_budget: "1000000000", denom: "ujuno", retained_option: "do-not-distribute", execution_window_seconds: 86400 }, current_epoch: null };
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

test("configured juno-1 artifact proves provenance and renders accepted-v2 empty state", async ({ page }) => {
  await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  await expect(page.getByText("No sample or demo records are shown.")).toBeVisible();
  await expect(page.getByText("juno-1", { exact: true })).toBeVisible();
  await expect(page.getByText("5155", { exact: true })).toBeVisible();
  await expect(page.getByText("40,746,625", { exact: true })).toBeVisible();
  await expect(
    page.getByText((releaseCommit ?? "").slice(0, 12) + "…", { exact: true }),
  ).toBeVisible();
});

test("freshness changes to stale in an open browser", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-12T12:00:00Z") });
  await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("Fresh direct-RPC observation")).toBeVisible();
  await page.clock.fastForward(60_002);
  await expect(page.getByText("Stale · retry recommended")).toBeVisible();
});

test("RPC errors are explicit and retry recovers", async ({ page }) => {
  await mockMainnet(page, { failures: 1 });
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("Mainnet data unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry query" }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
});

test("provenance mismatch fails closed", async ({ page }) => {
  await mockMainnet(page, { chain: "uni-7" });
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByText(/expected chain juno-1, observed uni-7/)).toBeVisible();
});

test("hard refresh performs a new direct-RPC observation", async ({ page }) => {
  const observed = await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  const first = observed.requests();
  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
  expect(observed.requests()).toBeGreaterThan(first);
});

test("gauge route checks the mocked v2 identity profile and empty-state safety semantics", async ({ page }) => {
  await mockMainnet(page);
  await gotoDeployableArtifact(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Gauge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weighted allocation" })).toBeVisible();
  await expect(page.getByText("No epoch has opened")).toBeVisible();
  await page.getByText("How retained value and fixed options work").click();
  await expect(page.getByText(/Nothing shown here implies an automatic rollover/)).toBeVisible();
  await page.getByRole("link", { name: "Open voting workbench" }).click();
  await expect(page).toHaveURL(/\/gauge\/vote$/);
  await expect(page.getByText(/transaction support is unavailable in this browser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare open epoch" })).toHaveCount(0);
});

test("footer opens the dedicated FAQ and the logo returns home", async ({ page }) => {
  await mockMainnet(page);
  await gotoDeployableArtifact(page);

  await expect(page.getByText("NEW TO JUNO VOICE?")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: /^FAQ/ }).click();
  await expect(page).toHaveURL(/\/faq$/);
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bounties", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Public bounty ledger" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Gauge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weighted allocation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Eligible projects" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expectNoBrowserErrors();
});

test("verified project metadata renders real names from the gateway", async ({ page }) => {
  const { createHash } = await import("node:crypto");
  const projectDoc = '{"doc":"juno-voice/project","name":"Alpha Project","summary":"A test project.","version":1}';
  const projectDigest = `sha256:${createHash("sha256").update(projectDoc).digest("hex")}`;
  const owner = "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac";
  await mockMainnet(page, { registryProjects: [{
    id: 7, owner, payout_address: owner, metadata_uri: "ipfs://bafyalphaproject", metadata_digest: projectDigest,
    status: "active", created_at: "1", updated_at: "1", status_history_count: 1, address_history_count: 0,
    provenance: { bonded_registration: { applicant: owner } },
    bond: { amount: "100000000", depositor: owner, state: "deposited" },
    pending_payout_address: null, latest_review: null,
  }] });
  await page.route("https://ipfs-gateway.test/ipfs/bafyalphaproject", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: projectDoc }));
  await page.goto(`${projectPath}projects`);
  await expect(page.getByRole("heading", { name: "Alpha Project" })).toBeVisible();
  await expect(page.getByText("Project #7")).toBeVisible();
});

test("mismatching metadata is withheld, not rendered", async ({ page }) => {
  const owner = "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac";
  await mockMainnet(page, { registryProjects: [{
    id: 8, owner, payout_address: owner, metadata_uri: "ipfs://bafytampered", metadata_digest: `sha256:${"1".repeat(64)}`,
    status: "active", created_at: "1", updated_at: "1", status_history_count: 1, address_history_count: 0,
    provenance: { bonded_registration: { applicant: owner } },
    bond: { amount: "100000000", depositor: owner, state: "deposited" },
    pending_payout_address: null, latest_review: null,
  }] });
  await page.route("https://ipfs-gateway.test/ipfs/bafytampered", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: '{"doc":"juno-voice/project","name":"Impostor","summary":"Tampered.","version":1}' }));
  await page.goto(`${projectPath}projects`);
  await expect(page.getByRole("heading", { name: "ipfs://bafytampered" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Impostor" })).toHaveCount(0);
});

test("deep links load each routed page directly", async ({ page }) => {
  await mockMainnet(page);
  await page.goto(`${projectPath}bounties`);
  await expect(page.getByRole("heading", { name: "Public bounty ledger" })).toBeVisible();
  await page.goto(`${projectPath}faq`);
  await expect(page.getByRole("heading", { name: /Questions, answered plainly/ })).toBeVisible();
  await page.goto(`${projectPath}no-such-page`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("the create-bounty modal is route-addressed, traps focus, and closes with Escape", async ({ page }) => {
  await mockMainnet(page);
  await page.goto(`${projectPath}bounties`);
  const createLink = page.getByRole("link", { name: "Create a bounty" });
  await createLink.click();
  await expect(page).toHaveURL(/\/bounties\/create$/);
  const dialog = page.getByRole("dialog", { name: "Create a bounty" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^Title/)).toBeVisible();
  // Focus is contained by the top-layer dialog.
  await page.keyboard.press("Tab");
  await expect(dialog.locator(":focus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/bounties$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Focus returns to the header action that opened the modal.
  await expect(createLink).toBeFocused();
});

test("a direct load of the create modal renders the page behind it", async ({ page }) => {
  await mockMainnet(page);
  await page.goto(`${projectPath}bounties/create`);
  await expect(page.getByRole("dialog", { name: "Create a bounty" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/bounties$/);
  await expect(page.getByRole("heading", { name: "Public bounty ledger" })).toBeVisible();
});

test("baked per-route metadata is served for crawlers and unfurlers", async ({ page }) => {
  const bounties = await page.request.get(`${projectPath}bounties/`);
  const bountiesHtml = await bounties.text();
  expect(bountiesHtml).toContain("<title data-static-head>Public bounty ledger · Juno Voice</title>");
  expect(bountiesHtml).toContain('property="og:title"');
  const create = await page.request.get(`${projectPath}bounties/create/`);
  expect(await create.text()).toContain('name="robots" content="noindex"');
  const root = await page.request.get(projectPath);
  expect(await root.text()).toContain("Juno Voice · Community funding on Juno");
});

test("the live app owns per-route document titles after boot", async ({ page }) => {
  await mockMainnet(page);
  await page.goto(`${projectPath}bounties`);
  await expect(page).toHaveTitle("Public bounty ledger · Juno Voice");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Gauge", exact: true }).click();
  await expect(page).toHaveTitle("Funding gauge · Juno Voice");
  await page.getByRole("link", { name: "Open voting workbench" }).click();
  await expect(page).toHaveTitle("Gauge voting workbench · Juno Voice");
});

test("legacy #faq deep links redirect onto the /faq route", async ({ page }) => {
  await mockMainnet(page);
  await page.goto(`${projectPath}#faq`);
  await expect(page).toHaveURL(/\/faq$/);
  await expect(page.getByRole("heading", { name: /Questions, answered plainly/ })).toBeVisible();
});

test("keyboard reaches primary navigation and the public retry action", async ({ page }) => {
  await mockMainnet(page, { failures: 1 });
  await gotoDeployableArtifact(page);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Juno VOICE" })).toBeFocused();
  const primaryNavigation = page.getByRole("navigation", { name: "Primary" });
  for (const name of ["Bounties"]) {
    await page.keyboard.press("Tab");
    await expect(primaryNavigation.getByRole("link", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page.getByText("Mainnet data unavailable")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Retry query" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No on-chain bounties yet")).toBeVisible();
});
