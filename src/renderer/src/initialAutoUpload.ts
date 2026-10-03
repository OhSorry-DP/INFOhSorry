export const INITIAL_AUTO_UPLOAD_STABLE_MS = 2_000;

export type AutoUploadReadiness = {
  rowsPresent: boolean;
  dpReady: boolean;
  rReady: boolean;
  spReady: boolean;
  modelsReady: boolean;
};

export function isInitialAutoUploadReady(value: AutoUploadReadiness): boolean {
  // null도 계산이 완료된 결과다. 모델과 현재 행 데이터는 준비되어 있어야 한다.
  return value.rowsPresent && value.dpReady && value.rReady && value.spReady && value.modelsReady;
}
