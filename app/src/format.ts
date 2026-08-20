export const compact = (value: string) => value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
