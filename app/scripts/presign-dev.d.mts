import type { Plugin } from "vite";

export declare const PRESIGN_PATH: string;
export declare const DEV_IPFS_PREFIX: string;
export declare const DEV_GATEWAY_PATH: string;
export declare const DEV_UPLOAD_PATH: string;
export declare const DEV_PIN_DIR: string;

export type PresignDevMode = "disabled" | "pinata" | "offline";

export declare function createPresignDev(options?: {
  command?: string;
  mode?: string;
  isPreview?: boolean;
  env?: Record<string, string | undefined>;
  root?: string;
}): { mode: PresignDevMode; why: string | null; env: Record<string, string>; plugin: Plugin | null };
