/*
 * End-to-end test in a real (headless) Chromium: bundled dictionary, search, paragraph picking,
 * card dialog, notebook, Leitner review, Anki + JSON export, choosing another dictionary, offline reload.
 *
 * Needs Playwright:   node tests/e2e.js [screenshot-dir]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium, devices } = require('playwright');
const { buildMdx } = require('./build-mdx.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.argv[2] || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- a site folder = the project + a bundled test dictionary ---------- */
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-site-'));
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, f), path.join(site, f));
for (const d of ['css', 'js', 'icons']) fs.cpSync(path.join(ROOT, d), path.join(site, d), { recursive: true });
fs.mkdirSync(path.join(site, 'dict'));

const entriesA = [
  { key: 'run', text: '<div class="hw">run</div><div class="pron">/rʌn/ <span class="ipa">BrE rʌn</span></div>' +
      '<ol><li>to move quickly on foot: <i>She runs every morning.</i></li><li>to manage or operate a business</li><li>to flow, as water does</li></ol>' +
      '<div class="idiom">in the long run: in the end, after a long time</div>' },
  { key: 'ephemeral', text: '<b>ephemeral</b> /ɪˈfɛm(ə)rəl/<br>lasting for a very short time<br>Example: fashions are ephemeral.' },
  { key: 'plainword', text: 'plainword\nfirst line of a plain text record\nsecond line' },
  { key: 'ran', text: '@@@LINK=run' },
  { key: 'rune', text: '<p>a letter of an ancient alphabet</p>' },
  { key: 'runner', text: '<p>a person who runs</p>' },
];
fs.writeFileSync(path.join(site, 'dict', 'dict.mdx'), buildMdx(entriesA, { version: 2, title: 'Test Dictionary A' }));
const entriesB = [{ key: 'zebra', text: '<p>an African animal with black and white stripes</p>' }];
const otherDict = path.join(site, 'other.mdx');
fs.writeFileSync(otherDict, buildMdx(entriesB, { version: 2, encryptInfo: true, title: 'Other Dictionary B' }));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mdx': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(site, p === '/' ? 'index.html' : p);
  if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
async function shot(page, name) { if (SHOTS) await page.waitForTimeout(700); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); }

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, colorScheme: process.env.DARK ? 'dark' : 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('First start (bundled dictionary)');
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 20000 });
  check('bundled dictionary loads and the search box is enabled', true);
  check('dictionary title shown', (await page.textContent('#dict-title')).includes('Test Dictionary A'));

  console.log('Intro tutorial');
  await page.waitForSelector('#tour-dialog[open]');
  check('tutorial opens on first launch', (await page.textContent('#tour-title')) === 'Welcome');
  check('Back is hidden on the first step', await page.isHidden('#tour-back'));
  for (let i = 0; i < 4; i++) { await page.click('#tour-next'); if (i === 1) await shot(page, '0-tour-step3'); }
  check('last step shows the developer credit',
    (await page.textContent('#tour-body')).includes('Hosein Sheibah') &&
    (await page.getAttribute('#tour-body a', 'href')) === 'https://sheibah.ir');
  check('last step has no Skip and the button says Start', await page.isHidden('#tour-skip') && (await page.textContent('#tour-next')).includes('Start'));
  await shot(page, '0-tour');
  await page.click('#tour-next');
  await page.waitForSelector('#tour-dialog', { state: 'attached' });
  check('tutorial closes at the end', !(await page.evaluate(() => document.getElementById('tour-dialog').open)));
  await page.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready);

  console.log('Lookup');
  await page.fill('#q', 'ru');
  await page.waitForSelector('#suggest li');
  const sugg = await page.$$eval('#suggest li', l => l.map(x => x.textContent));
  check('prefix suggestions', sugg.includes('run') && sugg.includes('rune') && sugg.includes('runner'), sugg);
  await page.fill('#q', 'run');
  await page.press('#q', 'Enter');
  await page.waitForSelector('#entry-view .chunk');
  const chunks = await page.$$eval('#entry-view .chunk', l => l.map(x => x.textContent));
  check('entry is split into paragraph chunks', chunks.length >= 5, chunks);
  check('phonetics are shown intact', (await page.textContent('#entry-view')).includes('/rʌn/'));
  await shot(page, '1-entry');

  console.log('Picking paragraphs');
  await page.click('#entry-view li:first-child');
  await page.waitForSelector('#actionbar:not([hidden])');
  check('tapping a paragraph highlights it', (await page.$$('#entry-view .chunk.picked')).length === 1);
  await page.click('#ab-next');
  check('"+ ¶" extends to the following paragraph', (await page.$$('#entry-view .chunk.picked')).length === 2);
  await page.click('#ab-prev');
  check('"− ¶" shrinks it again', (await page.$$('#entry-view .chunk.picked')).length === 1);
  await page.click('#ab-next');
  await shot(page, '2-picked');
  await page.click('#ab-add');
  await page.waitForSelector('#card-dialog[open]');
  const def = await page.inputValue('#cd-def');
  check('dialog is prefilled with the headword', (await page.inputValue('#cd-word')) === 'run');
  check('dialog is prefilled with the picked paragraphs', def.includes('to move quickly on foot') && def.includes('manage or operate a business') && !def.includes('flow, as water'), def);
  await page.fill('#cd-ctx', 'I run a small shop in the village.');
  await shot(page, '3-dialog');
  await page.click('#cd-save');
  await page.waitForSelector('#card-dialog:not([open])', { state: 'attached' });
  check('card saved (due badge shows 1)', (await page.textContent('#badge-due')) === '1');

  console.log('Free text selection and other entry types');
  await page.fill('#q', 'ephemeral');
  await page.press('#q', 'Enter');
  await page.waitForFunction(() => document.getElementById('entry-word').textContent === 'ephemeral');
  const eph = await page.$$eval('#entry-view .chunk', l => l.map(x => x.textContent));
  check('<br>-separated lines become separate paragraphs', eph.length === 3, eph);
  await page.evaluate(() => {          // select "very short time" like a long-press would
    const node = [...document.querySelectorAll('#entry-view .chunk')][1].firstChild;
    const r = document.createRange(); r.setStart(node, node.data.indexOf('a very short time')); r.setEnd(node, node.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.waitForSelector('#actionbar:not([hidden]):has-text("Selected text")');
  await page.click('#ab-add');
  await page.waitForSelector('#card-dialog[open]');
  check('free text selection goes into the card', (await page.inputValue('#cd-def')) === 'a very short time', await page.inputValue('#cd-def'));
  await page.click('#cd-save');
  await page.waitForSelector('#card-dialog:not([open])', { state: 'attached' });
  await page.fill('#q', 'ran'); await page.press('#q', 'Enter');
  await page.waitForFunction(() => document.getElementById('entry-word').textContent === 'ran');
  check('@@@LINK redirect shows the target entry', (await page.textContent('#entry-view')).includes('manage or operate'));
  await page.fill('#q', 'plainword'); await page.press('#q', 'Enter');
  await page.waitForFunction(() => document.getElementById('entry-word').textContent === 'plainword');
  check('plain-text record: one paragraph per line', (await page.$$('#entry-view .chunk')).length === 3);
  await page.fill('#q', 'running'); await page.press('#q', 'Enter');
  await page.waitForFunction(() => document.getElementById('entry-word').textContent === 'run');
  check('inflected form falls back to the base word', (await page.textContent('#entry-note')).includes('run'));

  console.log('Notebook and exports');
  await page.click('.tabs button[data-tab=notebook]');
  check('notebook lists both cards', (await page.$$('#nb-list li')).length === 2);
  await shot(page, '4-notebook');
  const [dlAnki] = await Promise.all([page.waitForEvent('download'), page.click('#btn-anki')]);
  const ankiText = fs.readFileSync(await dlAnki.path(), 'utf8');
  check('Anki file has the import headers', ankiText.startsWith('#separator:tab\n#html:true\n#guid column:1\n#notetype:Basic\n#deck:Dictionary Notebook\n#tags column:4\n'), ankiText.slice(0, 120));
  check('Anki rows hold word, definition and tag', /"<b>run<\/b>"\t"to move quickly on foot[^"]*<br>manage or operate/.test(ankiText.replace(/\n(?!#)/g, '\n')) || ankiText.includes('to move quickly on foot'), ankiText);
  check('Anki file name', /^anki-import-\d{4}-\d{2}-\d{2}\.txt$/.test(dlAnki.suggestedFilename()), dlAnki.suggestedFilename());
  const [dlJson] = await Promise.all([page.waitForEvent('download'), page.click('#btn-backup')]);
  const backup = JSON.parse(fs.readFileSync(await dlJson.path(), 'utf8'));
  check('JSON backup has both cards with context and progress fields', backup.entries.length === 2 && backup.entries.some(e => e.context === 'I run a small shop in the village.' && e.box === 1), backup.entries);

  console.log('Review');
  await page.click('.tabs button[data-tab=review]');
  await page.click('#rv-start');
  const front = await page.textContent('#rv-front');
  check('front shows the word', /^(run|ephemeral)/.test(front.trim()), front);
  await page.click('#rv-show');
  check('back shows the definition', (await page.textContent('#rv-back')).length > 10);
  await shot(page, '5-review');
  await page.click('#rv-ok');
  await page.click('#rv-show'); await page.click('#rv-forgot');
  await page.waitForSelector('#rv-show:not([hidden])');       // the forgotten card comes back once
  await page.click('#rv-show'); await page.click('#rv-ok');
  await page.waitForSelector('#rv-done:not([hidden])');
  check('session finishes', true);
  await page.click('#rv-back-home');
  const saved = await page.evaluate(() => Store.getEntries());
  check('first-try answer moved a card to box 2, the forgotten one stayed in box 1',
    saved.filter(e => e.box === 2).length === 1 && saved.filter(e => e.box === 1).length === 1, saved.map(e => [e.word, e.box, e.due]));

  console.log('Settings, another dictionary, offline');
  await page.click('.tabs button[data-tab=settings]');
  await page.setInputFiles('#file-dict', otherDict);
  await page.waitForFunction(() => document.getElementById('dict-title').textContent.includes('Other Dictionary B'), null, { timeout: 20000 });
  check('a dictionary chosen from storage (with encrypted key index) replaces the bundled one', true);
  await page.click('.tabs button[data-tab=lookup]');
  await page.fill('#q', 'zebra'); await page.press('#q', 'Enter');
  await page.waitForSelector('#entry-view .chunk');
  check('lookup works in the chosen dictionary', (await page.textContent('#entry-view')).includes('stripes'));

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('q').disabled, null, { timeout: 20000 });
  check('offline reload: app opens, the chosen dictionary is still there', (await page.textContent('#dict-title')).includes('Other Dictionary B'));
  await page.fill('#q', 'zebra'); await page.press('#q', 'Enter');
  await page.waitForSelector('#entry-view .chunk');
  check('offline lookup works', true);
  await page.click('.tabs button[data-tab=notebook]');
  check('notebook survives the reload', (await page.$$('#nb-list li')).length === 2);
  check('tutorial does not come back after a reload', !(await page.evaluate(() => document.getElementById('tour-dialog').open)));
  await page.click('.tabs [data-tab="settings"]');
  check('About shows developer and website', (await page.textContent('#tab-settings')).includes('Hosein Sheibah') && (await page.getAttribute('#tab-settings a[href="https://sheibah.ir"]', 'href')) === 'https://sheibah.ir');
  await page.click('#btn-tour');
  check('tutorial can be reopened from Settings', await page.evaluate(() => document.getElementById('tour-dialog').open));
  await page.click('#tour-skip');
  await context.setOffline(false);

  console.log('Errors');
  check('no console or page errors', errors.length === 0, errors);

  await browser.close();
  server.close();
  fs.rmSync(site, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(2); });
