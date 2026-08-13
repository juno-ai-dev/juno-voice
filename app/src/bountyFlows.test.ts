import { describe, expect, it } from "vitest";
import executeSchema from "../../contracts/juno-voice-bounties/schema/raw/execute.json";
import { createBountyIntent, contributeIntent, type EligibilityState } from "./bountyFlows";
import { bounty, config, ledger } from "./test/bountyFixtures";
const state: EligibilityState = { config: ledger.config, pause: ledger.pause,
  chainTimeNanos: "1700000000000000000", fingerprint: "canonical:v1" };
const digest = `sha256:${"ab".repeat(32)}`;
const create = { title: "Ship tooling", summary: "Useful public tooling", acceptanceCriteria: "Tests and release notes",
  contentUri: "ipfs://bafyterms", contentDigest: digest, expiresAtNanos: "1700086400000000000", initialJuno: "1" };
describe("schema-backed bounty execute construction", () => {
  it("keeps create and contribute aligned with the checked-in live execute schema", () => {
    const actions = executeSchema.oneOf.map((entry) => Object.keys(entry.properties)[0]);
    expect(actions).toContain("create_bounty");
    expect(actions).toContain("contribute");
    const createDefinition = executeSchema.oneOf.find((entry) => "create_bounty" in entry.properties);
    expect(createDefinition).toBeDefined();
    expect(createDefinition?.properties.create_bounty?.required).toEqual(expect.arrayContaining(["title", "summary", "acceptance_criteria", "expires_at"]));
  });
  it("constructs the exact checked-in create_bounty wire shape, ujuno, and nanosecond expiry", () => {
    expect(createBountyIntent(create, state, config.contract)).toEqual({ chainId: "juno-1", contract: config.contract,
      executeMessage: { create_bounty: { title: create.title, summary: create.summary,
        acceptance_criteria: create.acceptanceCriteria, content_uri: create.contentUri, content_digest: digest,
        expires_at: create.expiresAtNanos, project_candidate: null } },
      funds: [{ denom: "ujuno", amount: "1000000" }], consequences: expect.any(Array), expectedStateFingerprint: "canonical:v1" });
  });
  it("constructs exact contribute and preserves amounts as strings", () => {
    expect(contributeIntent({ ...bounty, terms: { ...bounty.terms, max_bounty_total: "340282366920938463463374607431768211455" } },
      "9007199254.740993", bounty.creator, [bounty.creator], state, config.contract)).toMatchObject({
      executeMessage: { contribute: { bounty_id: 1 } }, funds: [{ denom: "ujuno", amount: "9007199254740993" }] });
  });
  it.each([
    ["paused", create, { ...state, pause: { ...state.pause, paused: true } }],
    ["minimum", { ...create, initialJuno: "0.999999" }, state],
    ["expiry", { ...create, expiresAtNanos: state.chainTimeNanos }, state],
    ["title bytes", { ...create, title: "🪐".repeat(30) }, state],
    ["metadata pair", { ...create, contentDigest: "" }, state],
    ["unsafe URI", { ...create, contentUri: "javascript:alert(1)" }, state],
    ["digest", { ...create, contentDigest: `sha256:${"AB".repeat(32)}` }, state],
    ["project metadata", { ...create, projectCandidate: { metadataUri: "", metadataDigest: "" } }, state],
  ])("rejects create boundary: %s", (_, input, canonical) => {
    expect(() => createBountyIntent(input as typeof create, canonical, config.contract)).toThrow();
  });
  it("uses chain time and snapshotted bounty caps for contribution eligibility", () => {
    expect(() => contributeIntent({ ...bounty, expires_at: state.chainTimeNanos }, "1", null, [], state, config.contract)).toThrow(/chain time/);
    expect(() => contributeIntent({ ...bounty, total_contribution: bounty.terms.max_bounty_total }, "1", null, [], state, config.contract)).toThrow(/snapshotted/);
    expect(() => contributeIntent({ ...bounty, contributor_count: bounty.terms.max_contributors }, "1", "juno1new", [], state, config.contract)).toThrow(/contributor cap/);
    expect(() => contributeIntent({ ...bounty, contributor_count: bounty.terms.max_contributors }, "1",
      "juno1existing", ["juno1existing"], state, config.contract)).not.toThrow();
  });
});
