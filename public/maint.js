/*
 * Announced-maintenance bar. Added 2026-10-03 for the rack move.
 *
 * A plain file outside the build on purpose: it can be added and removed without
 * rebuilding the client bundle, and as a 'self' script plus a 'self' stylesheet it
 * fits the strict CSP without any change to the server. The bar hides itself once
 * UNTIL has passed, so leaving this file in place afterwards does nothing.
 * To remove it for good: delete this file, maint.css and the
 * <script src="/build/maint.js"> line in each page, rebuild, and deploy.
 * The build hashes this file like the bundles (scripts/build-client.mjs).
 */
(function () {
  'use strict';
  var UNTIL = Date.parse('2026-10-11T22:00:00+02:00');
  var TEXT = 'On Saturday 10 and Sunday 11 October we are moving all our hardware into a ' +
    'server rack. Aurora FileShare will be unavailable for part of that time. It is our ' +
    'first time doing this, so it may take a little longer than planned.';

  if (!(Date.now() < UNTIL)) return;

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/maint.css';
  document.head.appendChild(css);

  function show() {
    if (document.getElementById('maint-bar')) return;
    var bar = document.createElement('aside');
    bar.id = 'maint-bar';
    bar.setAttribute('role', 'note');
    var inner = document.createElement('div');
    inner.className = 'maint-in';
    var tag = document.createElement('span');
    tag.className = 'maint-tag';
    tag.textContent = 'Maintenance';
    var p = document.createElement('p');
    p.textContent = TEXT;
    inner.appendChild(tag);
    inner.appendChild(p);
    bar.appendChild(inner);
    var host = document.querySelector('.page') || document.body;
    host.insertBefore(bar, host.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
