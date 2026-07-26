import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadConfig } from './config';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
try {
  const config = loadConfig({
    VITE_CHAIN_ID: import.meta.env.VITE_CHAIN_ID,
    VITE_CONTRACT_ADDRESS: import.meta.env.VITE_CONTRACT_ADDRESS,
    VITE_RPC_URL: import.meta.env.VITE_RPC_URL,
    VITE_EXPLORER_URL: import.meta.env.VITE_EXPLORER_URL,
  });
  createRoot(root).render(<StrictMode><App config={config} /></StrictMode>);
} catch (error: unknown) {
  const main = document.createElement('main');
  main.className = 'fatal';
  const heading = document.createElement('h1');
  heading.textContent = 'Configuration blocked';
  const detail = document.createElement('p');
  detail.textContent = error instanceof Error ? error.message : 'Invalid configuration';
  main.append(heading, detail);
  root.replaceChildren(main);
}
