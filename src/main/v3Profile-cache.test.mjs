import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

test('CDN 프로필 로더의 TTL·병합·오류 보존 및 compose 계약', async () => {
  const root = new URL('../', import.meta.url);
  const fixture = await mkdtemp(join(tmpdir(), 'v3-profile-'));
  try {
    const main = join(fixture, 'main'); const shared = join(fixture, 'shared');
    await mkdir(main); await mkdir(shared);
    const source = await readFile(new URL('./v3Profile.ts', import.meta.url), 'utf8');
    await writeFile(join(main, 'v3Profile.ts'), source.replace("'../shared/match'", "'../shared/match.ts'").replace("'./remoteRecent'", "'./remoteRecent.ts'"));
    await copyFile(new URL('./remoteRecent.ts', import.meta.url), join(main, 'remoteRecent.ts'));
    await copyFile(new URL('../shared/match.ts', import.meta.url), join(shared, 'match.ts'));
    await copyFile(new URL('../shared/types.ts', import.meta.url), join(shared, 'types.ts'));
    const norm = await readFile(new URL('../shared/normTitle.js', import.meta.url), 'utf8');
    await writeFile(join(shared, 'normTitle.js'), norm);
    const match = await readFile(join(shared, 'match.ts'), 'utf8');
    await writeFile(join(shared, 'match.ts'), match.replace("'./normTitle'", "'./normTitle.js'"));
    const { createV3CdnProfileLoader, composeV3Profile, buildSongIndex } = await import(pathToFileURL(join(main, 'v3Profile.ts')).href);
    let clock = 1000; let calls = [];
    let reply = () => new Response(JSON.stringify({ _v: 1, user: { iidx_id: 'ABC' }, dp: [], sp: [] }), { status: 200 });
    const fetchMock = async (url, init) => { calls.push({ url: String(url), init }); return reply(); };
    const loader = createV3CdnProfileLoader(fetchMock, () => clock);
    const [a, b] = await Promise.all([loader.load('ab-c'), loader.load('ABC')]);
    assert.equal(calls.length, 1); assert.equal(a.status, 'ok'); assert.equal(b.revision, '1');
    assert.match(calls[0].url, /\/user\/ABC\.json$/); assert.equal(calls[0].init.cache, 'no-store');
    clock += 59999; await loader.load('ABC'); assert.equal(calls.length, 1);
    clock += 1; await loader.load('ABC'); assert.equal(calls.length, 2);
    await loader.load('DEF'); assert.equal(calls.length, 3);
    reply = () => new Response('', { status: 404 }); clock += 60000; assert.equal((await loader.load('MISS')).status, 'notfound');
    clock += 59999; await loader.load('MISS'); assert.equal(calls.length, 4);
    clock += 1; reply = () => new Response(JSON.stringify({ _v: 2, user: { iidx_id: 'MISS' }, dp: [], sp: [] }), { status: 200 });
    assert.equal((await loader.load('MISS')).status, 'ok');
    clock += 60000; reply = () => { throw Error('offline'); };
    const failed = await loader.load('MISS'); assert.equal(failed.status, 'error'); assert.equal(failed.value._v, 2);
    clock += 59999; await loader.load('MISS'); assert.equal(calls.length, 6);
    clock += 1; await loader.load('MISS'); assert.equal(calls.length, 7);

    const songs = buildSongIndex([{ title: 'Example', song_id: 5, ac: 2 }]);
    const remote = { iidx_id: 'ABC', charts_json: [{ title: 'Example', diff: 'ANOTHER', lampNum: 5, exScore: 900, missCount: 10, noteCount: 500 }] };
    const cdn = { _v: 99, user: { iidx_id: 'ABC' }, dp: [{ song_id: '5', diff: 3, played_version: 0, lamp: 4, ex_score: 800 }], sp: [] };
    const composed = composeV3Profile(remote, cdn, songs, '2026-10-01T15:00:00.000Z');
    assert.deepEqual(composed.remote_recent.rows, [[5, 3, 5, 900, 0, '2026-10-01T15:00:00.000Z', '2026-10-02', 1, 10, 500]]);
    assert.equal(composed.remote_recent.cdn_revision, '99'); assert.equal(cdn.dp[0].lamp, 4);
    const mismatch = composeV3Profile(remote, { ...cdn, user: { iidx_id: 'OTHER' } }, songs, '2026-10-01T15:00:00.000Z');
    assert.deepEqual(mismatch.remote_recent.rows, []); assert.equal(mismatch.remote_recent.cdn_revision, null);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
