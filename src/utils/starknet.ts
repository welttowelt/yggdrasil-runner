import { validateAndParseAddress } from "starknet";

export function normalizeStarknetAddress(address?: string | null): string | null {
  const raw = (address ?? "").trim();
  if (!raw) return null;
  try {
    return validateAndParseAddress(raw);
  } catch {
    return null;
  }
}

export function starknetAddressesEqual(a?: string | null, b?: string | null): boolean {
  const na = normalizeStarknetAddress(a);
  const nb = normalizeStarknetAddress(b);
  if (na && nb) return na === nb;
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

