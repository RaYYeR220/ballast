export class Web3ApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly httpStatus: number,
    readonly code: string,
    readonly serverMessage: string,
    readonly retryable: boolean,
  ) {
    super(`${endpoint} → HTTP ${httpStatus} code ${code}: ${serverMessage}`);
    this.name = "Web3ApiError";
  }
}

export const GEO_BLOCK_CODE = "40304";

export function isGeoBlocked(e: unknown): boolean {
  return e instanceof Web3ApiError && e.code === GEO_BLOCK_CODE;
}

const SUCCESS = new Set(["0", "000000", "000000000"]);

export function isSuccessCode(code: unknown): boolean {
  return code !== undefined && code !== null && SUCCESS.has(String(code));
}
