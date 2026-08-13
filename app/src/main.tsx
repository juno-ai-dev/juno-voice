import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadConfig } from "./config";
import "./design-system/styles.css";
import "./styles.css";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
try {
  const config = loadConfig({
    VITE_PROTOCOL_VERSION: import.meta.env.VITE_PROTOCOL_VERSION,
    VITE_CHAIN_ID: import.meta.env.VITE_CHAIN_ID,
    VITE_BOUNTY_CONTRACT_ADDRESS: import.meta.env.VITE_BOUNTY_CONTRACT_ADDRESS,
    VITE_BOUNTY_CODE_ID: import.meta.env.VITE_BOUNTY_CODE_ID,
    VITE_BOUNTY_CODE_CHECKSUM: import.meta.env.VITE_BOUNTY_CODE_CHECKSUM,
    VITE_REGISTRY_CONTRACT_ADDRESS: import.meta.env.VITE_REGISTRY_CONTRACT_ADDRESS,
    VITE_REGISTRY_CODE_ID: import.meta.env.VITE_REGISTRY_CODE_ID,
    VITE_REGISTRY_CODE_CHECKSUM: import.meta.env.VITE_REGISTRY_CODE_CHECKSUM,
    VITE_VAULT_CONTRACT_ADDRESS: import.meta.env.VITE_VAULT_CONTRACT_ADDRESS,
    VITE_VAULT_CODE_ID: import.meta.env.VITE_VAULT_CODE_ID,
    VITE_VAULT_CODE_CHECKSUM: import.meta.env.VITE_VAULT_CODE_CHECKSUM,
    VITE_VOTING_CONTRACT_ADDRESS: import.meta.env.VITE_VOTING_CONTRACT_ADDRESS,
    VITE_VOTING_CODE_ID: import.meta.env.VITE_VOTING_CODE_ID,
    VITE_VOTING_CODE_CHECKSUM: import.meta.env.VITE_VOTING_CODE_CHECKSUM,
    VITE_GAUGE_CONTRACT_ADDRESS: import.meta.env.VITE_GAUGE_CONTRACT_ADDRESS,
    VITE_GAUGE_CODE_ID: import.meta.env.VITE_GAUGE_CODE_ID,
    VITE_GAUGE_CODE_CHECKSUM: import.meta.env.VITE_GAUGE_CODE_CHECKSUM,
    VITE_RPC_URL: import.meta.env.VITE_RPC_URL,
    VITE_EXPLORER_URL: import.meta.env.VITE_EXPLORER_URL,
    VITE_RELEASE_COMMIT: import.meta.env.VITE_RELEASE_COMMIT,
  });
  createRoot(root).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
} catch (error) {
  const main = document.createElement("main");
  main.className = "fatal";
  const h = document.createElement("h1");
  h.textContent = "Configuration blocked";
  const p = document.createElement("p");
  p.textContent =
    error instanceof Error ? error.message : "Invalid configuration";
  main.append(h, p);
  root.replaceChildren(main);
}
