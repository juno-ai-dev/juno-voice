import { fromBech32 } from "@cosmjs/encoding";

// Juno has two address shapes, and the difference matters. Externally owned
// accounts carry 20 bytes; contract addresses (a DAO, a multisig, a vault)
// carry 32. The contracts validate every address they store with
// `addr_validate`, which accepts both, so anything that only receives funds
// must accept both: people fund DAOs.
//
// Signing is where the distinction is real. A contract cannot sign a
// transaction, so a connected wallet is always an account.

const ACCOUNT_BYTES = 20;
const CONTRACT_BYTES = 32;

function decodeJuno(value: string): number | null {
  try {
    if (value !== value.toLowerCase()) return null;
    const decoded = fromBech32(value);
    return decoded.prefix === "juno" ? decoded.data.length : null;
  } catch {
    return null;
  }
}

/** Any address the chain will accept: an account or a contract. */
export function isJunoAddress(value: string): boolean {
  const length = decodeJuno(value);
  return length === ACCOUNT_BYTES || length === CONTRACT_BYTES;
}

/** An externally owned account: the only thing that can sign a transaction. */
export function isJunoAccount(value: string): boolean {
  return decodeJuno(value) === ACCOUNT_BYTES;
}

/** A contract address, such as a DAO. */
export function isJunoContract(value: string): boolean {
  return decodeJuno(value) === CONTRACT_BYTES;
}
