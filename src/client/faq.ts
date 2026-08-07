import { renderDonateButton } from './donate.js';

// The documentation page is otherwise static; this is only here so the tip
// button appears in its footer like it does everywhere else.
renderDonateButton(document.querySelector('#donate-slot'));
