import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAY_CSV_KEYS } from '../shared/uploadSnapshot.ts';
import {
  PLAY_LOG_HEADER,
  PLAY_LOG_HEADER_V2,
  formatPlaySpeed,
  playSpeedFromSettingValue,
  PLAY_LOG_LAYOUT as L,
  buildPlayRow,
  decideState,
  findMarkerDelta,
  lookupSongInBuffer,
  parseOffsetsText,
  rankOf,
  resolvePlay,
} from './playLog.ts';

// 따옴표 안의 쉼표를 무시하고 CSV 한 줄을 열로 나눈다 (테스트 전용)
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

test('offsets.txt 파싱: 버전 줄은 무시하고 주소 키만 절대주소로 읽는다', () => {
  const text = 'P2D:J:B:A:2026101400\r\nsongList = 0x1431D5880\r\njudgeData = 0x14288718C\r\nplaySettings = 0x1425DA154\r\nplayData = 0x1425DA404\r\ncurrentsong = 0x142887370\r\n';
  const o = parseOffsetsText(text);
  assert.equal(o.songList, 0x1431d5880n);
  assert.equal(o.judgeData, 0x14288718cn);
  assert.equal(o.playSettings, 0x1425da154n);
  assert.equal(o.playData, 0x1425da404n);
  assert.equal(o.currentSong, 0x142887370n);
});

test('마커: 세 값이 8바이트 간격으로 10000 넘으면 두 번째 위치 + 24', () => {
  const buf = Buffer.alloc(96);
  buf.writeInt32LE(50000, 28);
  buf.writeInt32LE(50001, 36);
  buf.writeInt32LE(50002, 44);
  assert.equal(findMarkerDelta(buf), 36 + L.markerDelta);
});

test('마커: 간격이 다르면 찾지 못한다', () => {
  const buf = Buffer.alloc(96);
  buf.writeInt32LE(50000, 28);
  buf.writeInt32LE(50001, 40);
  buf.writeInt32LE(50002, 44);
  assert.equal(findMarkerDelta(buf), null);
});

test('상태 판정: 마커 != 0 이면 플레이 중, 아니면 PlaySettings-0x18 == 1 이 선택 화면', () => {
  assert.equal(decideState(7, 0), 'playing');
  assert.equal(decideState(0, 1), 'select');
  assert.equal(decideState(0, 0), 'result');
});

test('DJ 레벨 경계 (EX 레이트 기준)', () => {
  assert.equal(rankOf(8 / 9), 'AAA');
  assert.equal(rankOf(0.78), 'AA');
  assert.equal(rankOf(0.7), 'A');
  assert.equal(rankOf(0.6), 'B');
  assert.equal(rankOf(0.1), 'F');
});

// 곡 목록 버퍼: 엔트리 1번에 곡 ID 80123, 제목 "Deep tenDon Reflex", DPA(인덱스 8) 노트 1453
function fakeSongList() {
  const buf = Buffer.alloc(3 * L.songStride);
  const o = L.songStride;
  buf.write('Deep tenDon Reflex', o, 'utf16le');
  buf.writeInt32LE(80123, o + L.songIdOffset);
  buf.writeInt32LE(1453, o + L.songNoteOffset + 8 * 4);
  return buf;
}

test('곡 조회: ID 로 제목과 난이도별 노트 수를 찾는다', () => {
  const song = lookupSongInBuffer(fakeSongList(), 80123, 8);
  assert.deepEqual(song, { title: 'Deep tenDon Reflex', notes: 1453 });
});

test('곡 조회: 없는 ID 는 null', () => {
  assert.equal(lookupSongInBuffer(fakeSongList(), 99999, 8), null);
});

test('CSV 행: 열 수가 헤더와 같고, 배틀 플래그는 PlaySettings +0x28 값', () => {
  assert.equal(PLAY_LOG_HEADER, PLAY_CSV_KEYS.join(',') + ',play_speed'); // 공용 21열 + 기록기 전용 play_speed
  const p1 = Array.from({ length: 11 }, (_, i) => (i === 10 ? 1 : 0));
  const row = buildPlayRow({
    timestamp: '2026-10-14T11:11:20.779Z',
    songId: 80116,
    title: 'Euphoric Fragmentation',
    diff: 8,
    notes: 1715,
    exScore: 2038,
    pgreat: 765,
    great: 508,
    miss: 118,
    lamp: 1,
    judge16: [312, 258, 227, 21, 62, 453, 250, 142, 9, 26, 51, 22, 232, 217, 253, 175],
    p1Settings: p1,
    p2Settings: Array.from({ length: 11 }, () => 0),
    gauge: [0, 56],
    source: 'playdata',
    appVersion: '1.2.3',
    gameVersion: '2026101400',
    playSpeed: 0.7,
  });
  const f = splitCsv(row);
  assert.equal(f.length, PLAY_LOG_HEADER.split(',').length);
  assert.equal(f[2], 'Euphoric Fragmentation');
  assert.equal(f[3], 'DPA');
  assert.equal(f[5], '2038');
  assert.equal(f[10], '59.42');
  assert.equal(f[11], 'B');
  assert.equal(f[15], '1'); // battle_flag
  assert.equal(f[16], '0'); // gauge_p1
  assert.equal(f[17], '56'); // gauge_p2
  assert.equal(f[18], 'playdata');
  assert.equal(f[19], '1.2.3');
  assert.equal(f[20], '2026101400');
  assert.equal(f[21], '0.70'); // play_speed (맨 끝)
});

test('play_speed: 옵션 단계 -> 배율, 정상 범위만 소수 둘째 자리 문자열, 헤더는 21열 + play_speed', () => {
  // 실측: 0.80/0.85/0.90/1.00/1.05 -> 14/13/12/10/9
  for (const [v, x] of [[14, 0.8], [13, 0.85], [12, 0.9], [10, 1], [9, 1.05]]) assert.equal(playSpeedFromSettingValue(v), x);
  assert.equal(playSpeedFromSettingValue(-1), null);
  assert.equal(playSpeedFromSettingValue(99), null);
  assert.equal(formatPlaySpeed(0.7), '0.70');
  assert.equal(formatPlaySpeed(1), '1.00');
  assert.equal(formatPlaySpeed(null), '');
  assert.equal(formatPlaySpeed(123), '');
  assert.equal(PLAY_LOG_HEADER, PLAY_LOG_HEADER_V2 + ',play_speed');
  assert.equal(PLAY_LOG_HEADER.split(',').length, 22);
  assert.equal(L.playSpeedFromSettings, 0x17a0);
});

test('CSV 행: 제목의 따옴표는 두 번 써서 이스케이프', () => {
  const row = buildPlayRow({
    timestamp: 't', songId: 1, title: 'a"b', diff: 0, notes: 0, exScore: 0, pgreat: 0, great: 0, miss: 0, lamp: 0,
    judge16: [], p1Settings: [], p2Settings: [], gauge: [0, 0], source: 'playdata', appVersion: '', gameVersion: '',
  });
  assert.ok(row.includes('"a""b"'));
});

test('CSV 21 fields: versions containing commas, quotes, and newlines round trip', () => {
  const appVersion = 'app, "stable"\nnext';
  const gameVersion = 'game\n"rev",2';
  const row = buildPlayRow({
    timestamp: '2026-10-14T11:11:20.779Z', songId: 1, title: 'title', diff: 0, notes: 1, exScore: 1, pgreat: 0, great: 1, miss: 0, lamp: -1,
    judge16: [], p1Settings: [], p2Settings: [], gauge: [0, 0], source: 'currentsong', appVersion, gameVersion,
  });
  const fields = splitCsv(row);
  assert.equal(fields.length, 22);
  assert.equal(fields[19], appVersion);
  assert.equal(fields[20], gameVersion);
});

test('CSV battle row preserves normal lamp and the legacy 19-field prefix', () => {
  const snapshot = {
    timestamp: '2026-10-14T11:11:20.779Z', songId: 80126, title: 'battle', diff: 2, notes: 1672,
    exScore: 1788, pgreat: 719, great: 350, miss: 114, lamp: -1, judge16: BATTLE_JUDGE,
    p1Settings: Array.from({ length: 11 }, () => 0), p2Settings: Array.from({ length: 11 }, () => 0),
    gauge: [0, 56], source: 'currentsong', appVersion: 'app', gameVersion: 'game',
  };
  const fields = splitCsv(buildPlayRow(snapshot));
  assert.equal(fields.length, 22);
  assert.deepEqual(fields.slice(0, 19), [
    snapshot.timestamp, '80126', 'battle', 'SPH', '1672', '1788', '719', '350', '114', '-1',
    '53.47', 'C', BATTLE_JUDGE.join(' '), '0 0 0 0 0 0 0 0 0 0 0', '0 0 0 0 0 0 0 0 0 0 0',
    '0', '0', '56', 'currentsong',
  ]);
});

// 실제 배틀 플레이(2026-10-14 14:51 UTC)의 값: The 88's Instigation SPH, 양쪽 SP 차트(836노트 x 2)
const BATTLE_JUDGE = [304, 161, 225, 33, 57, 415, 189, 132, 7, 17, 66, 20, 105, 127, 281, 194];
const BATTLE_CS = [80126, 2, 0, 14, 1672];

test('배틀: PlayData 가 비어도 CurrentSong 과 판정 블록으로 곡·점수를 정한다', () => {
  const r = resolvePlay({ playData: new Array(8).fill(0), currentSong: BATTLE_CS, judge16: BATTLE_JUDGE, battle: true });
  assert.deepEqual(r, {
    songId: 80126,
    diff: 2, // SPH
    exScore: 2 * (304 + 415) + (161 + 189),
    pgreat: 304 + 415,
    great: 161 + 189,
    miss: 33 + 57 + 7 + 17,
    lamp: -1,
    source: 'currentsong',
    currentNotes: 1672,
  });
  assert.equal(r.exScore, 1788);
});

test('배틀: PlayData 에 이전 플레이 값이 남아 있어도 배틀이면 CurrentSong 경로를 쓴다', () => {
  const stale = [80123, 8, 1983, 58, 776, 431, 3, 0];
  const r = resolvePlay({ playData: stale, currentSong: BATTLE_CS, judge16: BATTLE_JUDGE, battle: true });
  assert.equal(r.source, 'currentsong');
  assert.equal(r.songId, 80126);
});

test('일반 플레이: PlayData 를 그대로 쓴다', () => {
  const pd = [80123, 8, 1983, 58, 776, 431, 3, 0];
  const r = resolvePlay({ playData: pd, currentSong: [80123, 3, 0, 14, 1453], judge16: BATTLE_JUDGE, battle: false });
  assert.deepEqual(r, { songId: 80123, diff: 8, exScore: 1983, miss: 58, pgreat: 776, great: 431, lamp: 3, source: 'playdata', currentNotes: null });
});

test('저장할 플레이가 없으면 null (일반인데 PlayData 가 비었거나, 배틀인데 CurrentSong 이 비었을 때)', () => {
  const zero = new Array(8).fill(0);
  assert.equal(resolvePlay({ playData: zero, currentSong: BATTLE_CS, judge16: BATTLE_JUDGE, battle: false }), null);
  assert.equal(resolvePlay({ playData: zero, currentSong: [0, 0, 0, 0, 0], judge16: BATTLE_JUDGE, battle: true }), null);
});

// 실제 값(2026-10-28, 0.70배 DP 플레이 직후): PlayData 는 전부 0, CurrentSong = [30006, 3, 0, 14, 2000]
test('배속 != 1.00: PlayData 가 비어도 CurrentSong + 판정 블록으로 만들고, 노트 수로 DP 를 가려 난이도에 +5', () => {
  const zero = new Array(8).fill(0);
  const judge = [300, 200, 100, 20, 30, 400, 250, 120, 10, 15, 0, 0, 0, 0, 0, 0];
  const r = resolvePlay({ playData: zero, currentSong: [30006, 3, 0, 14, 2000], judge16: judge, battle: false, speedChanged: true, chartNotes: { sp: 1500, dp: 2000 } });
  assert.deepEqual(r, { songId: 30006, diff: 8, exScore: 2 * 700 + 450, pgreat: 700, great: 450, miss: 75, lamp: -1, source: 'currentsong', currentNotes: 2000 });
});

test('배속 != 1.00: 노트 수가 SP 차트와 같으면 SP, 둘 다 같으면 P2 판정 합으로 가른다', () => {
  const zero = new Array(8).fill(0);
  const sp = [300, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(resolvePlay({ playData: zero, currentSong: [1, 2, 0, 14, 836], judge16: sp, battle: false, speedChanged: true, chartNotes: { sp: 836, dp: 1000 } }).diff, 2);
  const same = { playData: zero, currentSong: [1, 2, 0, 14, 800], battle: false, speedChanged: true, chartNotes: { sp: 800, dp: 800 } };
  assert.equal(resolvePlay({ ...same, judge16: sp }).diff, 2);
  assert.equal(resolvePlay({ ...same, judge16: [3, 2, 0, 0, 0, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0] }).diff, 7);
});

test('배속 != 1.00 이라도 CurrentSong 이 비면 null, 배속 1.00 이면 기존처럼 PlayData 가 비면 null', () => {
  const zero = new Array(8).fill(0);
  const j = new Array(16).fill(1);
  assert.equal(resolvePlay({ playData: zero, currentSong: [0, 0, 0, 0, 0], judge16: j, battle: false, speedChanged: true }), null);
  assert.equal(resolvePlay({ playData: zero, currentSong: [30006, 3, 0, 14, 2000], judge16: j, battle: false, speedChanged: false }), null);
});
