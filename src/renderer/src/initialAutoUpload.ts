export const INITIAL_AUTO_UPLOAD_STABLE_MS = 2_000;

export type AutoUploadReadiness = {
  rowsPresent: boolean;
  dpReady: boolean;
  rReady: boolean;
  spReady: boolean;
  modelsReady: boolean;
};

export function isInitialAutoUploadReady(value: AutoUploadReadiness): boolean {
  // Null is a completed calculation result; models and the current rows still must be ready.
  return value.rowsPresent && value.dpReady && value.rReady && value.spReady && value.modelsReady;
}
