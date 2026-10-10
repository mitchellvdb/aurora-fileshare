import { renderDonateButton } from './donate.js';

// The tip button sits in the header, as on every other page.
renderDonateButton(document.querySelector('#donate-slot'));

/**
 * "How long until the recipient can start?" on the 50 GB guide. The figures
 * are the guide's own (50 GB at 10, 40 and 100 Mbit/s); keep them in step with
 * its text. The bar width comes from a class rather than an inline style,
 * which the Content-Security-Policy would refuse.
 */
const WAIT: Record<string, { cls: string; text: string }> = {
  '10': { cls: '', text: 'roughly 11 hours' },
  '40': { cls: 's40', text: 'roughly 3 hours' },
  '100': { cls: 's100', text: 'a little over an hour' },
};

const buttons = [...document.querySelectorAll<HTMLButtonElement>('.speed')];
const bar = document.querySelector<HTMLElement>('.rbar.store');
const out = document.querySelector<HTMLElement>('#waittext');

for (const button of buttons) {
  button.addEventListener('click', () => {
    const pick = WAIT[button.dataset['speed'] ?? ''];
    if (!pick || !bar || !out) return;
    for (const other of buttons) {
      const on = other === button;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    bar.classList.remove('s40', 's100');
    if (pick.cls) bar.classList.add(pick.cls);
    out.textContent = pick.text;
  });
}
