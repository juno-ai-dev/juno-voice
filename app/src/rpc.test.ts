import { toBase64, toUtf8 } from "@cosmjs/encoding";
import {
  QueryCodeResponse,
  QueryContractInfoResponse,
  QuerySmartContractStateResponse,
} from "cosmjs-types/cosmwasm/wasm/v1/query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRpc } from "./rpc";

const jsonResponse = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
const abciResponse = (value: Uint8Array) => ({
  result: { response: { code: 0, value: toBase64(value) } },
});

describe("credential-free RPC adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves path-based RPC URLs and performs query-only protobuf reads", async () => {
    const seen: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        seen.push(url);
        if (url.pathname.endsWith("/status"))
          return jsonResponse({
            result: {
              node_info: { network: "juno-1" },
              sync_info: { latest_block_height: "40682089", latest_block_time: "2026-08-12T06:00:00.123456789Z" },
            },
          });
        const path = url.searchParams.get("path");
        if (path === '"/cosmwasm.wasm.v1.Query/ContractInfo"')
          return jsonResponse(
            abciResponse(
              QueryContractInfoResponse.encode(
                QueryContractInfoResponse.fromPartial({
                  address: "juno1contract",
                  contractInfo: { codeId: 5150n },
                }),
              ).finish(),
            ),
          );
        if (path === '"/cosmwasm.wasm.v1.Query/Code"')
          return jsonResponse(
            abciResponse(
              QueryCodeResponse.encode(
                QueryCodeResponse.fromPartial({
                  codeInfo: { dataHash: new Uint8Array([0xf0, 0x5e]) },
                }),
              ).finish(),
            ),
          );
        return jsonResponse(
          abciResponse(
            QuerySmartContractStateResponse.encode({
              data: toUtf8(JSON.stringify({ paused: false })),
            }).finish(),
          ),
        );
      }),
    );

    const client = await connectRpc("https://rpc.example/juno");
    expect(await client.getChainId()).toBe("juno-1");
    expect(await client.getHeight()).toBe(40682089);
    expect(await client.getChainTimeNanos()).toBe("1786514400123000000");
    expect(await client.getContract("juno1contract")).toEqual({
      address: "juno1contract",
      codeId: 5150,
    });
    expect(await client.getCodeDetails(5150)).toEqual({ checksum: "f05e" });
    expect(
      await client.queryContractSmart("juno1contract", { pause: {} }),
    ).toEqual({ paused: false });

    expect(seen.every((url) => url.pathname.startsWith("/juno/"))).toBe(true);
    expect(
      seen.filter((url) => url.pathname.endsWith("/abci_query")),
    ).toHaveLength(3);
    expect(
      seen.every((url) => url.username === "" && url.password === ""),
    ).toBe(true);
  });

  it("fails an ABCI response with a nonzero code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          result: {
            response: { code: 2, log: "contract not found", value: "" },
          },
        }),
      ),
    );
    const client = await connectRpc("https://rpc.example");
    await expect(client.getContract("juno1missing")).rejects.toThrow(
      "RPC query failed: contract not found",
    );
  });
});
