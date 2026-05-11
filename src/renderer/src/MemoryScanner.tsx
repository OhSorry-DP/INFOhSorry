// 메모리 스캐너 — INFINITAS 프로세스에서 DJ NAME / IIDX ID 위치 찾기.
//
// 방식: Reflux anchor 기반 pointer chain
//   1. 사용자가 본인 값 입력 → string scan → heap 주소 H 매칭
//   2. "저장" 클릭 → findAnchor(H): 정적 영역 안에서 H 를 가리키는 pointer 위치 P
//      → P 의 relative offset 과 가장 가까운 Reflux anchor 비교 → delta 계산
//   3. (anchor_name, delta, encoding) 저장
//   4. 읽기: readViaAnchor — 현재 Reflux offsets 의 anchor 값 + delta = pointer 위치
//      → pointer 따라가서 heap 주소 → string read
//
// 게임 패치 시:
//   - Reflux 가 offsets.txt 자동 갱신 → 우리 anchor 의 새 위치 자동 반영
//   - data section 안에서 anchor ~ pointer 거리가 안 바뀌면 delta 그대로 작동
import { useEffect, useState } from 'react';
import { IS_BROWSER_REMOTE } from './api';
import { PROFILE_OFFSETS } from '../../shared/profileOffsets';

const EXE_NAME = 'bm2dx.exe';

type FieldKey = 'djName' | 'iidxId' | 'spRank' | 'dpRank';
const STORAGE_KEY: Record<FieldKey, string> = {
  djName: 'infohsorry-scanner-djname-v2',
  iidxId: 'infohsorry-scanner-iidxid-v2',
  spRank: 'infohsorry-scanner-sprank-v2',
  dpRank: 'infohsorry-scanner-dprank-v2',
};

// 발견한 매치 결과 자체를 영속화 — 스캐너 창 닫았다 열어도 유지, "결과 지우기" 누를 때만 비움
const MATCHES_KEY: Record<FieldKey, string> = {
  djName: 'infohsorry-scanner-djname-matches-v1',
  iidxId: 'infohsorry-scanner-iidxid-matches-v1',
  spRank: 'infohsorry-scanner-sprank-matches-v1',
  dpRank: 'infohsorry-scanner-dprank-matches-v1',
};

function loadMatches(key: FieldKey): ScanMatch[] {
  try {
    const raw = localStorage.getItem(MATCHES_KEY[key]);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (m: unknown): m is ScanMatch =>
        !!m &&
        typeof (m as { encoding?: unknown }).encoding === 'string' &&
        typeof (m as { absolute?: unknown }).absolute === 'string' &&
        typeof (m as { relative?: unknown }).relative === 'string' &&
        typeof (m as { relativeRaw?: unknown }).relativeRaw === 'string',
    );
  } catch {
    return [];
  }
}

function saveMatches(key: FieldKey, m: ScanMatch[]): void {
  try {
    localStorage.setItem(MATCHES_KEY[key], JSON.stringify(m));
  } catch {}
}

// 사용자 저장값 → 없으면 프로젝트 기본 offset 사용 (있을 때만)
function getEffectiveSlot(key: FieldKey, saved: SavedSlot | null): SavedSlot | null {
  if (saved) return saved;
  const def = PROFILE_OFFSETS[key];
  if (!def) return null;
  return {
    mode: 'direct',
    offset: BigInt(def.offset).toString(),
    encoding: def.encoding,
    isStatic: true,
  };
}

interface ScanMatch {
  encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
  absolute: string;
  relative: string;
  relativeRaw: string;
}

// 두 모드:
//   - anchor: Reflux anchor + delta 따라서 pointer chain 으로 read (cross-restart 안정)
//   - direct: modBase + offset 으로 직접 read (정적 영역이면 cross-restart, heap 이면 세션만)
type SavedSlot =
  | {
      mode: 'anchor';
      anchor: string;
      delta: string;
      valueOffset: string;
      encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
    }
  | {
      mode: 'direct';
      offset: string;
      encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
      isStatic: boolean; // 정적 영역 안 (true) 인지 heap (false) 인지 — UI 경고용
    };

function loadSaved(key: FieldKey): SavedSlot | null {
  const raw = localStorage.getItem(STORAGE_KEY[key]);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<SavedSlot> & { mode?: string };
    if (j.mode === 'anchor' && j.anchor && j.delta && j.encoding) {
      return {
        mode: 'anchor',
        anchor: j.anchor,
        delta: j.delta,
        valueOffset: j.valueOffset || '0',
        encoding: j.encoding,
      };
    }
    if (j.mode === 'direct' && j.offset && j.encoding) {
      return {
        mode: 'direct',
        offset: j.offset,
        encoding: j.encoding,
        isStatic: !!j.isStatic,
      };
    }
    // 옛 저장본 (mode 없음) 호환 — anchor 로 가정
    if (
      typeof (j as { anchor?: unknown }).anchor === 'string' &&
      typeof (j as { delta?: unknown }).delta === 'string' &&
      (j.encoding === 'utf16le' || j.encoding === 'ascii')
    ) {
      return {
        mode: 'anchor',
        anchor: (j as { anchor: string }).anchor,
        delta: (j as { delta: string }).delta,
        valueOffset: (j as { valueOffset?: string }).valueOffset || '0',
        encoding: j.encoding,
      };
    }
  } catch {}
  return null;
}

function saveSlot(key: FieldKey, slot: SavedSlot): void {
  localStorage.setItem(STORAGE_KEY[key], JSON.stringify(slot));
}

function clearSlot(key: FieldKey): void {
  localStorage.removeItem(STORAGE_KEY[key]);
}

interface FieldPanelProps {
  fieldKey: FieldKey;
  label: string;
  hint: string;
  defaultMaxBytes: number;
  // anchor scan 건너뛰기 — 정적 메모리 매칭만 시도 (단위처럼 anchor 가 transient 일 때)
  directOnly?: boolean;
}

function FieldPanel({
  fieldKey,
  label,
  hint,
  defaultMaxBytes,
  directOnly = false,
}: FieldPanelProps): JSX.Element {
  const [input, setInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ScanMatch[]>(() => loadMatches(fieldKey));
  const [page, setPage] = useState(0);
  const [matchReadbacks, setMatchReadbacks] = useState<Record<string, string>>({});
  const PAGE_SIZE = 10;
  const [saved, setSaved] = useState<SavedSlot | null>(loadSaved(fieldKey));
  const [readback, setReadback] = useState<string | null>(null);
  const [readbackErr, setReadbackErr] = useState<string | null>(null);

  // matches 변경 시 페이지 0 으로 리셋 + readback 캐시 초기화 + localStorage 영속화
  useEffect(() => {
    setPage(0);
    setMatchReadbacks({});
    saveMatches(fieldKey, matches);
  }, [matches, fieldKey]);

  // 현재 페이지의 매치들에 대해 각 주소의 현재 메모리 값 fetch
  useEffect(() => {
    if (matches.length === 0) return;
    const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const start = safePage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, matches.length);
    const slice = matches.slice(start, end);
    if (slice.length === 0) return;
    let cancelled = false;
    Promise.all(
      slice.map(async (m) => {
        try {
          const r = await window.infohsorry.memory.readString(
            EXE_NAME,
            m.relativeRaw,
            m.encoding,
            defaultMaxBytes,
          );
          return { addr: m.absolute, value: r.ok ? r.text || '' : `<${r.error || '읽기 실패'}>` };
        } catch (e) {
          return { addr: m.absolute, value: `<${(e as Error).message}>` };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setMatchReadbacks((prev) => {
        const next = { ...prev };
        for (const { addr, value } of results) next[addr] = value;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [matches, page, defaultMaxBytes]);

  // 사용자 저장값 OR 프로젝트 기본 offset 으로 readback
  useEffect(() => {
    const slot = getEffectiveSlot(fieldKey, saved);
    if (!slot) {
      setReadback(null);
      setReadbackErr(null);
      return;
    }
    const promise =
      slot.mode === 'anchor'
        ? window.infohsorry.memory.readViaAnchor(
            EXE_NAME,
            slot.anchor,
            slot.delta,
            slot.encoding,
            defaultMaxBytes,
            slot.valueOffset,
          )
        : window.infohsorry.memory.readString(
            EXE_NAME,
            slot.offset,
            slot.encoding,
            defaultMaxBytes,
          );
    void promise.then((r) => {
      if (r.ok) {
        setReadback(r.text || '');
        setReadbackErr(null);
      } else {
        setReadback(null);
        setReadbackErr(r.error || '읽기 실패');
      }
    });
  }, [saved, defaultMaxBytes, fieldKey]);

  // 자동 검증 — directOnly 면 direct 만, 아니면 anchor 우선 → direct fallback.
  async function tryMatch(m: ScanMatch, input: string): Promise<SavedSlot | null> {
    if (!directOnly) {
      // anchor 모드 시도
      const heapAddrBig = BigInt(m.absolute);
      const fa = await window.infohsorry.memory.findAnchor(EXE_NAME, heapAddrBig.toString());
      if (fa.ok && fa.candidates) {
        for (const c of fa.candidates) {
          if (!c.anchorName || !c.anchorDelta) continue;
          const rv = await window.infohsorry.memory.readViaAnchor(
            EXE_NAME,
            c.anchorName,
            c.anchorDelta,
            m.encoding,
            defaultMaxBytes,
            c.valueOffset,
          );
          if (rv.ok && rv.text === input) {
            return {
              mode: 'anchor',
              anchor: c.anchorName,
              delta: c.anchorDelta,
              valueOffset: c.valueOffset,
              encoding: m.encoding,
            };
          }
        }
      }
    }

    // direct 모드
    const rd = await window.infohsorry.memory.readString(
      EXE_NAME,
      m.relativeRaw,
      m.encoding,
      defaultMaxBytes,
    );
    if (rd.ok && rd.text === input) {
      const isStatic = !m.relativeRaw.startsWith('-');
      return {
        mode: 'direct',
        offset: m.relativeRaw,
        encoding: m.encoding,
        isStatic,
      };
    }

    return null;
  }

  // "찾기" — 스캔 → 매칭 자동 순회 → anchor 우선, 정적 direct, heap direct 순으로 시도
  async function onScanAndAutoSave(): Promise<void> {
    if (!input.trim()) return;
    setScanning(true);
    setError(null);
    setMatches([]);
    setProgress(null);
    try {
      const r = await window.infohsorry.memory.scan(EXE_NAME, input);
      if (!r.ok) {
        setError(r.error || '스캔 실패');
        return;
      }
      const found = r.results || [];
      // 정적 매칭 (양수 offset) 을 우선 — cross-restart 안정성 더 높음
      const sorted = [...found].sort((a, b) => {
        const aStat = !a.relativeRaw.startsWith('-');
        const bStat = !b.relativeRaw.startsWith('-');
        if (aStat && !bStat) return -1;
        if (!aStat && bStat) return 1;
        return 0;
      });
      setMatches(sorted);
      if (sorted.length === 0) {
        setError('매칭 없음 — 게임에 그 값이 떠있는지 / 인코딩 확인');
        return;
      }
      for (let i = 0; i < sorted.length; i++) {
        setProgress(
          `${i + 1} / ${sorted.length} 시도 중... (${sorted[i].encoding}, ${
            sorted[i].relativeRaw.startsWith('-') ? 'heap' : '정적'
          })`,
        );
        const slot = await tryMatch(sorted[i], input);
        if (slot) {
          saveSlot(fieldKey, slot);
          setSaved(slot);
          setProgress(null);
          // 찾은 매치 목록은 유지 (사용자가 다른 매치도 비교/확인할 수 있게)
          return;
        }
      }
      setProgress(null);
      setError(`${found.length}개 매칭 모두 검증 실패 — 인코딩 / 입력값 확인`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  // "찾기만" — 스캔만 하고 매치 리스트만 표시 (자동 저장 X, 사용자가 수동으로 골라 저장)
  async function onScanOnly(): Promise<void> {
    if (!input.trim()) return;
    setScanning(true);
    setError(null);
    setMatches([]);
    setProgress('메모리 스캔 중...');
    try {
      const r = await window.infohsorry.memory.scan(EXE_NAME, input);
      if (!r.ok) {
        setError(r.error || '스캔 실패');
        return;
      }
      const found = r.results || [];
      // 정적 (양수 offset) 우선 정렬 — 위쪽에 표시되되 음수 (heap) 도 같이 보임
      const sorted = [...found].sort((a, b) => {
        const aStat = !a.relativeRaw.startsWith('-');
        const bStat = !b.relativeRaw.startsWith('-');
        if (aStat && !bStat) return -1;
        if (!aStat && bStat) return 1;
        return 0;
      });
      setMatches(sorted);
      if (sorted.length === 0) setError('매칭 없음 — 게임에 그 값이 떠있는지 / 인코딩 확인');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  // "이전 결과에서 다시 찾기" — Cheat Engine 의 next scan
  //   현재 matches 의 각 주소에서 새 input 으로 다시 검증 → 일치하는 것만 keep
  //   화면 바꿔 값 변경 후 좁힐 때 유용 (위치 고정 + 값만 다른 경우)
  //   input 이 빈 문자열이면: 현재 메모리 값이 빈 (NULL 시작) 매치만 좁힘
  async function onRefineScan(): Promise<void> {
    if (matches.length === 0) return;
    setScanning(true);
    setError(null);
    setProgress(`이전 매치 ${matches.length}개 좁히는 중...`);
    try {
      const prev = matches.map((m) => ({ encoding: m.encoding, absolute: m.absolute }));
      const r = await window.infohsorry.memory.refineScan(EXE_NAME, input, prev);
      if (!r.ok) {
        setError(r.error || 'refine scan 실패');
        return;
      }
      const found = r.results || [];
      const sorted = [...found].sort((a, b) => {
        const aStat = !a.relativeRaw.startsWith('-');
        const bStat = !b.relativeRaw.startsWith('-');
        if (aStat && !bStat) return -1;
        if (!aStat && bStat) return 1;
        return 0;
      });
      setMatches(sorted);
      if (sorted.length === 0) {
        setError(`이전 ${prev.length}개 모두 새 값과 불일치 — 입력값/인코딩 확인 후 다시 시도`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  // 수동 fallback — 자동이 실패할 때 매치 리스트에서 사용자가 직접 저장 시도
  // 저장 성공해도 매치 목록은 유지 (다른 매치와 비교/확인 위해)
  async function onSaveMatch(m: ScanMatch): Promise<void> {
    setError(null);
    const slot = await tryMatch(m, input);
    if (slot) {
      saveSlot(fieldKey, slot);
      setSaved(slot);
      return;
    }
    setError('이 매치도 검증 실패 — 다른 매치 시도');
  }

  function onClear(): void {
    clearSlot(fieldKey);
    setSaved(null);
    setReadback(null);
    setReadbackErr(null);
  }

  return (
    <div className="ms-field">
      <h3 className="ms-field-title">{label}</h3>
      <div className="ms-field-hint">{hint}</div>

      <div className="ms-saved">
        <div className="ms-saved-row">
          <span className="ms-saved-label">
            {saved ? '사용자 저장:' : PROFILE_OFFSETS[fieldKey] ? '기본값:' : '미저장:'}
          </span>
          <span className="ms-saved-offset">
            {(() => {
              const slot = getEffectiveSlot(fieldKey, saved);
              if (!slot) return <span className="ms-muted">아직 찾지 못함 — 입력 후 "찾기"</span>;
              if (slot.mode === 'anchor') {
                return (
                  <>
                    anchor: {slot.anchor} {BigInt(slot.delta) >= 0n ? '+' : ''}0x
                    {(BigInt(slot.delta) < 0n ? -BigInt(slot.delta) : BigInt(slot.delta)).toString(
                      16,
                    )}
                    {BigInt(slot.valueOffset) !== 0n &&
                      ` → +0x${BigInt(slot.valueOffset).toString(16)}`}{' '}
                    ({slot.encoding})
                  </>
                );
              }
              return (
                <>
                  direct: modBase {BigInt(slot.offset) >= 0n ? '+' : '-'}0x
                  {(BigInt(slot.offset) < 0n ? -BigInt(slot.offset) : BigInt(slot.offset)).toString(
                    16,
                  )}{' '}
                  ({slot.encoding}) {slot.isStatic ? '— 정적' : '— heap (세션 한정)'}
                </>
              );
            })()}
          </span>
          {saved && (
            <button type="button" className="ms-btn-secondary" onClick={onClear}>
              초기화
            </button>
          )}
        </div>
        <div className="ms-readback">
          현재 값:{' '}
          {readback != null ? (
            <code>{readback || '(빈 문자열)'}</code>
          ) : readbackErr ? (
            <span className="ms-error">{readbackErr}</span>
          ) : (
            <span className="ms-muted">읽는 중...</span>
          )}
        </div>
      </div>

      <div className="ms-input-row">
        <input
          type="text"
          className="ms-input"
          placeholder={`현재 게임에 보이는 ${label}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onScanAndAutoSave();
          }}
        />
        <button
          type="button"
          className="ms-btn-primary"
          onClick={() => void onScanAndAutoSave()}
          disabled={scanning || !input.trim()}
        >
          {scanning ? '진행 중...' : '찾기 + 자동 저장'}
        </button>
        <button
          type="button"
          className="ms-btn-secondary"
          onClick={() => void onScanOnly()}
          disabled={scanning || !input.trim()}
          title="스캔만 — 매치 목록만 표시 (자동 저장 X)"
        >
          {scanning ? '스캔 중...' : '찾기만'}
        </button>
        {matches.length > 0 && (
          <button
            type="button"
            className="ms-btn-secondary"
            onClick={() => void onRefineScan()}
            disabled={scanning}
            title={`이전 매치 ${matches.length}개 중 새 값과 일치하는 것만 keep (입력 비어있으면 현재 빈 값인 매치만)`}
          >
            {scanning ? '좁히는 중...' : `이전 결과에서 다시 (${matches.length})`}
          </button>
        )}
      </div>

      {progress && <div className="ms-muted ms-progress">{progress}</div>}
      {error && <div className="ms-error">{error}</div>}

      {matches.length > 0 && (() => {
        const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        const safePage = Math.min(page, totalPages - 1);
        const start = safePage * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, matches.length);
        const slice = matches.slice(start, end);
        return (
          <div className="ms-matches">
            <div className="ms-matches-header">
              <span>
                매칭 {matches.length}개 — 수동으로 저장 시도 가능. "이전 결과에서 다시" 로 좁히거나 입력값 변경 후 "찾기" 로 새로 검색
              </span>
              <button
                type="button"
                className="ms-btn-small"
                onClick={() => {
                  setMatches([]);
                  setError(null);
                }}
                title="발견된 매치 결과 모두 지움"
              >
                결과 지우기
              </button>
            </div>
            <table className="ms-matches-table">
              <thead>
                <tr>
                  <th>인코딩</th>
                  <th>주소 (절대)</th>
                  <th>offset (base 기준)</th>
                  <th>현재 값</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {slice.map((m, i) => {
                  const rb = matchReadbacks[m.absolute];
                  return (
                    <tr key={`${m.absolute}-${start + i}`}>
                      <td>
                        <code>{m.encoding}</code>
                      </td>
                      <td>
                        <code>{m.absolute}</code>
                      </td>
                      <td>
                        <code>{m.relative}</code>
                      </td>
                      <td>
                        {rb === undefined ? (
                          <span className="ms-muted">읽는 중...</span>
                        ) : (
                          <code className="ms-match-value">{rb || '(빈 문자열)'}</code>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ms-btn-small"
                          onClick={() => void onSaveMatch(m)}
                        >
                          저장
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="ms-pagination">
              <button
                type="button"
                className="ms-btn-small"
                onClick={() => setPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
              >
                ◀ 이전
              </button>
              <span className="ms-muted ms-page-info">
                {safePage + 1} / {totalPages} 페이지 ({start + 1}~{end} / {matches.length})
              </span>
              <button
                type="button"
                className="ms-btn-small"
                onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                disabled={safePage >= totalPages - 1}
              >
                다음 ▶
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export function MemoryScanner({ onClose }: { onClose: () => void }): JSX.Element | null {
  if (IS_BROWSER_REMOTE) return null;

  return (
    <div className="ms-overlay" onClick={onClose}>
      <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ms-header">
          <h2>프로필 스캐너 — DJ NAME / IIDX ID</h2>
          <button type="button" className="ms-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <div className="ms-body">
          <p className="ms-intro">
            INFINITAS 메모리에서 DJ NAME / IIDX ID 위치를 찾아 Reflux anchor 기반으로 저장합니다. 게임 재시작 / ASLR 무관하게 자동 따라가고, Reflux 가 offsets.txt 갱신해주면 게임 패치도 대부분 자동 대응. 게임이 실행 중이고 한 번이라도 e-amusement 에 로그인한 상태여야 메모리에 값이 있습니다.
          </p>
          <FieldPanel
            fieldKey="djName"
            label="DJ NAME"
            hint="현재 게임 화면에 보이는 본인 DJ NAME 을 그대로 입력 (대소문자 구분)"
            defaultMaxBytes={64}
          />
          <FieldPanel
            fieldKey="iidxId"
            label="INFINITAS ID"
            hint='형식: "C-2930-3689-1870" (대문자 + 3 × 4자리 숫자 + 하이픈). 하이픈 포함해서 그대로 입력. 매칭 안 되면 하이픈 빼고 시도'
            defaultMaxBytes={64}
          />
        </div>
      </div>
    </div>
  );
}
