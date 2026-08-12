import { fromBase64, fromUtf8, toHex, toUtf8 } from "@cosmjs/encoding";
import {
  QueryCodeRequest,
  QueryCodeResponse,
  QueryContractInfoRequest,
  QueryContractInfoResponse,
  QuerySmartContractStateRequest,
  QuerySmartContractStateResponse,
} from "cosmjs-types/cosmwasm/wasm/v1/query";

export interface RpcClient {
  queryContractSmart(address: string, query: object): Promise<unknown>;
  getChainId(): Promise<string>;
  getHeight(): Promise<number>;
  getChainTimeNanos(): Promise<string>;
  getContract(address: string): Promise<{ address: string; codeId: number }>;
  getCodeDetails(codeId: number): Promise<{ checksum: string }>;
  disconnect(): void;
}

export type Connect = (rpc: string) => Promise<RpcClient>;

export const connectRpc: Connect = async (rpc) => {
  const base = new URL(rpc);
  const endpoint = (path: string) =>
    new URL(
      path.replace(/^\//, ""),
      base.href.endsWith("/") ? base : new URL(`${base.href}/`),
    );
  const fetchJson = async (target: string | URL) => {
    const response = await fetch(
      typeof target === "string" ? endpoint(target) : target,
    );
    if (!response.ok)
      throw new Error(`RPC request failed (${response.status}).`);
    return response.json() as Promise<unknown>;
  };
  const status = async () => {
    const body = (await fetchJson("/status")) as {
      result?: {
        node_info?: { network?: unknown };
        sync_info?: { latest_block_height?: unknown; latest_block_time?: unknown };
      };
    };
    const network = body.result?.node_info?.network;
    const height = body.result?.sync_info?.latest_block_height;
    const time = body.result?.sync_info?.latest_block_time;
    if (typeof network !== "string" || typeof height !== "string" || typeof time !== "string")
      throw new Error("Malformed status response from RPC.");
    return { network, height, time };
  };
  const abci = async (path: string, request: Uint8Array) => {
    const url = endpoint("/abci_query");
    url.searchParams.set("path", `"${path}"`);
    url.searchParams.set("data", `0x${toHex(request)}`);
    url.searchParams.set("prove", "false");
    const body = (await fetchJson(url)) as {
      result?: {
        response?: { code?: unknown; log?: unknown; value?: unknown };
      };
    };
    const result = body.result?.response;
    if (!result || (result.code !== undefined && result.code !== 0))
      throw new Error(
        `RPC query failed${typeof result?.log === "string" ? `: ${result.log}` : "."}`,
      );
    if (typeof result.value !== "string")
      throw new Error("Malformed ABCI response from RPC.");
    return fromBase64(result.value);
  };

  return {
    async queryContractSmart(address, query) {
      const request = QuerySmartContractStateRequest.encode({
        address,
        queryData: toUtf8(JSON.stringify(query)),
      }).finish();
      const response = QuerySmartContractStateResponse.decode(
        await abci("/cosmwasm.wasm.v1.Query/SmartContractState", request),
      );
      return JSON.parse(fromUtf8(response.data)) as unknown;
    },
    async getChainId() {
      return (await status()).network;
    },
    async getHeight() {
      const height = Number((await status()).height);
      if (!Number.isSafeInteger(height) || height < 0)
        throw new Error("Malformed height response from RPC.");
      return height;
    },
    async getChainTimeNanos() {
      const milliseconds = Date.parse((await status()).time);
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new Error("Malformed chain time response from RPC.");
      return (BigInt(milliseconds) * 1_000_000n).toString();
    },
    async getContract(address) {
      const request = QueryContractInfoRequest.encode({ address }).finish();
      const response = QueryContractInfoResponse.decode(
        await abci("/cosmwasm.wasm.v1.Query/ContractInfo", request),
      );
      const codeId = Number(response.contractInfo.codeId);
      if (!Number.isSafeInteger(codeId) || codeId < 0)
        throw new Error("Malformed contract info response from RPC.");
      return { address: response.address, codeId };
    },
    async getCodeDetails(codeId) {
      const request = QueryCodeRequest.encode({
        codeId: BigInt(codeId),
      }).finish();
      const response = QueryCodeResponse.decode(
        await abci("/cosmwasm.wasm.v1.Query/Code", request),
      );
      if (!response.codeInfo)
        throw new Error("Malformed code response from RPC.");
      return { checksum: toHex(response.codeInfo.dataHash) };
    },
    disconnect() {},
  };
};
