import { renderDonateButton } from './donate.js';

// The tip button sits in the header, as on every other page.
renderDonateButton(document.querySelector('#donate-slot'));

/**
 * The category chips above the questions. Without script every question is
 * simply shown, which is also what "All" does.
 */
const chips = [...document.querySelectorAll<HTMLButtonElement>('.cat')];
const items = [...document.querySelectorAll<HTMLDetailsElement>('.qa')];

for (const chip of chips) {
  chip.addEventListener('click', () => {
    const cat = chip.dataset['cat'] ?? 'all';
    for (const other of chips) {
      const on = other === chip;
      other.classList.toggle('on', on);
      other.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const item of items) item.hidden = !(cat === 'all' || item.dataset['cat'] === cat);
  });
}

// A link straight to one answer (/faq#...) should arrive with it open.
function openFromHash(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
    target.scrollIntoView({ block: 'start' });
  }
}
window.addEventListener('hashchange', openFromHash);
openFromHash();
