// Declarations for the release-gate behavioral test, matching the script import convention.
export const REQUIRED_API_REVISION: string;
export const REQUIRED_INFRA_REVISION: string;
export function verifyCompatibleApi(evidence: unknown, opts?: {
  endpoints?: string[];
  fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
}): Promise<{
  status: "PASS";
  endpoints: Array<{ endpoint: string; chainId: number; requests: number; apiRevision: string; infraRevision: string; behavior: string }>;
  limits: string;
}>;
