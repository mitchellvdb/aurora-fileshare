import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import puppeteer from 'puppeteer-core';
const OUT = '/root/.claude/jobs/cdf639f5/tmp/shots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const port = await new Promise((r) => { const p = createServer(); p.listen(0,'127.0.0.1',()=>{const{port}=p.address();p.close(()=>r(port));}); });
const srv = spawn(process.execPath, ['dist/server/index.js'], { cwd: '/opt/aurora-fileshare', env: { ...process.env, PORT: String(port), DONATE_URL: 'https://paypal.me/mvdbosch' }, stdio: 'ignore' });
for (let i=0;i<50;i++){ try{ await fetch(`http://127.0.0.1:${port}/healthz`); break; }catch{ await new Promise(r=>setTimeout(r,100)); } }

const b = await puppeteer.launch({ executablePath:'/usr/bin/chromium', headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--force-device-scale-factor=1'] });
const page = await b.newPage();
await page.setViewport({ width: 1280, height: 1000 });
const errs = [];
page.on('pageerror', e=>errs.push(String(e)));
page.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });

async function grab(url, name, prep) {
  await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil:'networkidle0' });
  await page.evaluate(()=>document.fonts.ready);
  if (prep) await prep();
  await new Promise(r=>setTimeout(r,350));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const info = await page.evaluate(()=>({
    archivo: document.fonts.check('600 24px Archivo'),
    mono: document.fonts.check('400 13px "JetBrains Mono"'),
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    stepCols: (()=>{ const g=document.querySelector('.steps-grid'); return g?getComputedStyle(g).gridTemplateColumns.split(' ').length:0; })(),
    h1: getComputedStyle(document.querySelector('h1')).fontFamily.split(',')[0],
  }));
  console.log(name.padEnd(14), JSON.stringify(info));
}

await grab('/', 'home-idle');
await grab('/', 'home-files', async () => {
  await page.evaluate(()=>{
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(1234567)], 'holiday-photos.zip', {type:'application/zip'}));
    dt.items.add(new File([new Uint8Array(48000)], 'notes.txt', {type:'text/plain'}));
    const i = document.querySelector('#file-input');
    i.files = dt.files; i.dispatchEvent(new Event('change', {bubbles:true}));
  });
});
// Real share: exercises the link state and a live recipient row.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil:'networkidle0' });
await page.evaluate(()=>{
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(2_400_000)], 'holiday-photos.zip', {type:'application/zip'}));
  const i = document.querySelector('#file-input');
  i.files = dt.files; i.dispatchEvent(new Event('change', {bubbles:true}));
});
await page.waitForFunction(()=>!document.querySelector('#start-share').disabled);
await page.evaluate(()=>document.querySelector('#start-share').click());
await page.waitForFunction(()=>document.querySelector('#share-url')?.value?.startsWith('http'), {timeout:15000});
await page.evaluate(()=>document.fonts.ready);
await new Promise(r=>setTimeout(r,400));
await page.screenshot({ path: `${OUT}/home-link.png`, fullPage: true });
console.log('home-link      captured');

const url = await page.$eval('#share-url', el=>el.value);
const peer = await b.newPage();
await peer.setViewport({ width: 1280, height: 1000 });
await peer.goto(url, { waitUntil:'networkidle0' });
await peer.waitForFunction(()=>{const x=document.querySelector('#file-list button.download');return x&&!x.disabled;},{timeout:20000});
await peer.evaluate(()=>document.querySelector('#file-list button.download').click());
await new Promise(r=>setTimeout(r,900));
await peer.screenshot({ path: `${OUT}/download-live.png`, fullPage: true });
await page.screenshot({ path: `${OUT}/home-xfer.png`, fullPage: true });
console.log('download-live + home-xfer captured');
await peer.close();

await grab('/faq', 'faq');
await grab('/d/nonexistent-slug', 'download');
console.log('page errors:', errs.length ? errs.join(' | ') : 'none');
await b.close(); srv.kill();
