const MICRO_JUNO = 1_000_000n;
export const UJUNO_MAX = 340282366920938463463374607431768211455n;

function grouped(digits: string): string {
  const first = digits.length % 3 || 3;
  return [digits.slice(0, first), ...digits.slice(first).match(/.{3}/g) ?? []].join(",");
}

/** Convert an exact backend ujuno integer to the user-facing $JUNO representation. */
export function formatJuno(ujuno: string): string {
  if (!/^(0|[1-9]\d*)$/.test(ujuno)) throw new Error("Invalid backend native-token amount.");
  const value = BigInt(ujuno);
  if (value > UJUNO_MAX) throw new Error("Backend native-token amount exceeds Uint128.");
  const whole = (value / MICRO_JUNO).toString();
  const fraction = (value % MICRO_JUNO).toString().padStart(6, "0").replace(/0+$/, "");
  return `$JUNO ${grouped(whole)}${fraction ? `.${fraction}` : ""}`;
}

/** Parse a decimal user-facing $JUNO amount into an exact backend ujuno integer. */
export function parseJuno(juno: string, { positive = true }: { positive?: boolean } = {}): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(juno);
  if (!match) throw new Error("Amount must be a decimal $JUNO value with at most 6 fractional digits.");
  const value = BigInt(match[1]) * MICRO_JUNO + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  if (positive && value === 0n) throw new Error("Amount must be greater than $JUNO 0.");
  if (value > UJUNO_MAX) throw new Error("Amount exceeds the supported $JUNO range.");
  return value.toString();
}

export function formatJunoCoin(coin: { readonly denom: string; readonly amount: string }): string {
  if (coin.denom !== "ujuno") throw new Error("Unsupported native-token denomination.");
  return formatJuno(coin.amount);
}

export function userFacingTransactionAmounts(review: {
  readonly funds: readonly { readonly denom: string; readonly amount: string }[];
  readonly fee: { readonly gas: string; readonly amount: readonly { readonly denom: string; readonly amount: string }[] };
}) {
  return {
    funds: review.funds.map(formatJunoCoin),
    fee: { gas: review.fee.gas, amount: review.fee.amount.map(formatJunoCoin) },
  };
}
