import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { registerWebPages, registerWebPageGuards } from '../server/web-pages.mjs';
import { problems, readGuides, renderHelp } from '../scripts/build-help.mjs';

const publicRoot = path.resolve('public');
const guides = JSON.parse(await fs.readFile(path.join(publicRoot, 'help/guides.json'), 'utf8'));
const ids = ['connect-ai', 'create-first-duck', 'first-task', 'needs-you', 'task-board', 'files', 'computers', 'team', 'webhooks'];
const page = name => fs.readFile(path.join(publicRoot, 'help', name + '.html'), 'utf8');
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function fixture(t, appOnly) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duck-help-'));
  const dist = path.join(root, 'dist');
  await fs.mkdir(dist);
  await fs.cp(path.join(publicRoot, 'help'), path.join(dist, 'help'), { recursive: true });
  for (const [name, body] of Object.entries({ index: 'APP', home: 'HOME', enter: 'ENTER', login: 'LOGIN', start: 'START', pricing: 'PRICING' }))
    await fs.writeFile(path.join(dist, name + '.html'), body);
  if (appOnly) await fs.writeFile(path.join(dist, 'distribution.json'), '{"edition":"community"}');
  const app = express();
  registerWebPageGuards(app, { root });
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  registerWebPages(app, { root, signedIn: req => req.headers.cookie === 'signed=1', appOnly });
  const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => listener.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { dist, get: (url, signed = false) => fetch(`http://127.0.0.1:${listener.address().port}${url}`, signed ? { headers: { cookie: 'signed=1' } } : {}) };
}

for (const appOnly of [false, true]) test(`help is accessible with and without sign-in (${appOnly ? 'app-only' : 'hosted'})`, async t => {
  const { get, dist } = await fixture(t, appOnly);
  for (const signed of [false, true]) {
    for (const url of ['/help', '/help/', '/help/guides.json', '/help/help.css', '/help/help-search.js', '/help/help-guides.js', '/help/help-guide.js', ...ids.map(id => '/help/' + id)]) {
      const response = await get(url, signed);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('cache-control'), /no-cache/, url);
      const body = await response.text();
      if (url.startsWith('/help/') && ids.includes(url.slice(6))) assert.ok(body.includes(`<h1>${escapeHtml(guides.find(g => g.id === url.slice(6)).title)}</h1>`), url);
    }
    for (const url of ['/help/unknown', '/help/screenshots/missing.png', '/help/missing.js', '/help/unknown/nested', '/help/not-a-guide.html'])
      assert.equal((await get(url, signed)).status, 404, url);
    assert.equal(await (await get('/', signed)).text(), signed ? 'APP' : appOnly ? 'ENTER' : 'HOME');
  }
  assert.equal(await (await get('/login')).text(), 'LOGIN');
  assert.equal((await get('/pricing')).status, appOnly ? 404 : 200);
  assert.equal(await (await get('/w/company/chat')).text(), 'APP');
  for (const guide of guides) {
    const response = await get(guide.steps.find(s => s.image).image.src);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/png/);
    assert.match(response.headers.get('cache-control'), /no-cache/);
  }
  await fs.rm(path.join(dist, 'help/team.html'));
  assert.equal((await get('/help/team')).status, 404);
});

test('guides.json is whole: every guide, step, screenshot and ring checks out', () => {
  assert.deepEqual(guides.map(g => g.id), ids);
  assert.deepEqual(problems(guides), []);
  for (const guide of guides) for (const step of guide.steps) assert.ok(step.title && step.do, guide.id);
  // What the checks catch, so a broken guide cannot slip through them.
  const broken = structuredClone(guides);
  broken[0].steps[0].image.marks[0].x = 5000;
  broken[1].steps[0].do = '';
  broken[2].steps[0].more = 'Go to [the shop](https://example.com).';
  broken[3].quick = [99];
  broken[4].steps[0].image.width = 10;
  assert.deepEqual([...new Set(problems(broken).map(p => p.split(':')[0]))], [
    'connect-ai step 1', 'create-first-duck step 1', 'first-task step 1', 'needs-you', 'task-board step 1',
  ]);
});

test('the Help pages are built from guides.json, and are up to date with it', async () => {
  const built = renderHelp(readGuides());
  assert.deepEqual([...built.keys()].sort(), ['help-guides.js', 'index.html', ...ids.map(id => id + '.html')].sort());
  for (const [name, body] of built)
    assert.equal(await fs.readFile(path.join(publicRoot, 'help', name), 'utf8'), body, `${name} is out of date: run node scripts/build-help.mjs`);
  // The pages' search matches with the very code the in-app panel uses.
  assert.ok(built.get('help-guides.js').endsWith(await fs.readFile('shared/help-guides.mjs', 'utf8')));
});

test('each guide page carries every step of its guide, in order, with its screenshots', async () => {
  for (const guide of guides) {
    const article = await page(guide.id);
    assert.ok(article.includes(`<h1>${escapeHtml(guide.title)}</h1>`), guide.id);
    const steps = [...article.matchAll(/<li class="step(?: is-last)?" id="step-(\d+)">([\s\S]*?)\n<\/li>/g)];
    assert.equal(steps.length, guide.steps.length, guide.id + ' steps');
    for (const [index, [, number, body]] of steps.entries()) {
      const step = guide.steps[index];
      assert.equal(Number(number), index + 1, guide.id + ' anchors in order');
      assert.ok(body.includes(`Step ${index + 1}: </span>${escapeHtml(step.title)}</h2>`), `${guide.id}: ${step.title}`);
      if (step.image) assert.ok(body.includes(`src="${step.image.src}"`), `${guide.id} step ${number} screenshot`);
      assert.ok(article.includes(`href="#step-${number}" data-step="${number}"`), guide.id + ' step navigation');
    }
    for (const match of article.matchAll(/(?:src|data-zoom)="([^"#]+)"/g)) {
      if (match[1].startsWith('/help/help-')) continue;
      assert.ok(match[1].startsWith('/'), match[1]);
      await fs.access(path.join(publicRoot, match[1]));
    }
    for (const match of article.matchAll(/href="(\/help\/[^"#]+)/g)) {
      if (['/help/help.css'].includes(match[1])) continue;
      assert.ok(guides.some(g => '/help/' + g.id === match[1]), match[1]);
    }
  }
  const hub = await page('index');
  for (const guide of guides) assert.ok(hub.includes(`href="/help/${guide.id}"`), guide.id + ' on the Help home');
  const css = await fs.readFile(path.join(publicRoot, 'help/help.css'), 'utf8');
  for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
    assert.ok(match[1].startsWith('/'), match[1]);
    await fs.access(path.join(publicRoot, match[1]));
  }
});

test('Help navigation matches its edition without changing the guide content', async () => {
  for (const community of [false, true]) for (const [name, html] of renderHelp(guides, { community })) {
    if (!name.endsWith('.html')) continue;
    const header = html.match(/<header class="site-header">([\s\S]*?)<\/header>/)?.[1] ?? '';
    const nav = header.match(/<nav class="nav-right"[\s\S]*?<\/nav>/)?.[0] ?? '';
    assert.deepEqual([...nav.matchAll(/<a[^>]*href="([^"]+)"/g)].map(m => m[1]), community
      ? ['https://tameduck.com', '/help', '/login', '/']
      : ['/pricing', '/help', '/login', '/start'], name);
    if (community) {
      assert.match(nav, />Open TameDuck /, name);
      assert.doesNotMatch(html, /href="\/(?:pricing|#)|Try it for &euro;1/, name);
      const hosted = renderHelp(guides, { community: false }).get(name);
      assert.equal(html.match(/<main[\s\S]*?<\/main>/)?.[0], hosted.match(/<main[\s\S]*?<\/main>/)?.[0], name);
    } else assert.match(nav, />Try it for &euro;1 /, name);
    assert.match(nav, /href="\/help" aria-current="(page|true)"/, name);
    assert.doesNotMatch(header, /href="\/#/, name + ' has no home-page section links');
  }
});

test('on a phone, the text scrolling under the step numbers does not show through them', async () => {
  const css = await fs.readFile(path.join(publicRoot, 'help/help.css'), 'utf8');
  const strip = css.match(/\.step-strip\{position:sticky[^}]*\}/)?.[0];
  assert.ok(strip, 'the step numbers stay at the top of the screen');
  const background = strip.match(/background:([^;}]+)/)?.[1] ?? '';
  assert.match(background, /^(#[0-9a-f]{3}|#[0-9a-f]{6}|var\(--[a-z-]+\))$/i, `a solid background, not "${background}"`);
});

test('help interactions use external scripts allowed by the site policy', async t => {
  const scripts = new Set();
  for (const name of ['index', ...ids]) {
    const html = await page(name);
    const tags = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.ok(tags.length, name + ' interaction script');
    for (const [, attributes, body] of tags) {
      assert.equal(body.trim(), '', name + ' must not use inline JavaScript');
      const source = attributes.match(/src="([^"]+)"/)?.[1];
      assert.match(source ?? '', /^\/help\/[^/]+\.js$/, name + ' same-origin script');
      assert.match(attributes, /\bdefer\b|type="module"/, name + ' script waits for the page');
      scripts.add(source);
    }
    assert.doesNotMatch(html, /\son[a-z]+="/, name + ' inline event handlers');
  }
  const { get } = await fixture(t, false);
  for (const source of [...scripts, '/help/help-guides.js']) {
    const response = await get(source);
    assert.equal(response.status, 200, source);
    assert.match(response.headers.get('cache-control'), /no-cache/, source);
    assert.match(response.headers.get('content-type'), /javascript/, source);
    const body = await response.text();
    if (/^\s*(import|export) /m.test(body)) {
      // A module: let Node read it as one, without running it.
      const file = path.join(os.tmpdir(), `help-${process.pid}-${path.basename(source, '.js')}.mjs`);
      await fs.writeFile(file, body);
      const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      await fs.rm(file, { force: true });
      assert.equal(parsed.status, 0, source + ': ' + parsed.stderr);
    } else assert.doesNotThrow(() => new vm.Script(body), source);
  }
});
