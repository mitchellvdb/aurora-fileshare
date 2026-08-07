/**
 * Optional "buy me a coffee" link.
 *
 * The URL is baked into the document as a meta tag by the server, so the
 * button renders with the first paint and never appears if DONATE_URL is
 * unset. The icon is inline SVG rather than a hosted badge image: the CSP
 * limits img-src to 'self', and pulling a third-party badge would also leak
 * every visitor to that host.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function meta(name: string): string | null {
  const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const value = el?.content?.trim();
  return value ? value : null;
}

function coffeeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  // Cup, handle, and a wisp of steam.
  const paths = [
    'M4 9h13v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9z',
    'M17 10h1.5a2.5 2.5 0 0 1 0 5H17',
    'M8 2v2.5M12 2v2.5',
  ];
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Renders the button into `slot` if a donation URL is configured.
 * Returns true when something was rendered.
 */
export function renderDonateButton(slot: HTMLElement | null): boolean {
  if (!slot) return false;

  const url = meta('aurora-donate-url');
  if (!url) return false;
  const label = meta('aurora-donate-label') ?? 'Buy me a coffee';

  const link = document.createElement('a');
  link.className = 'donate';
  link.href = url;
  link.target = '_blank';
  // noopener stops the donation page reaching back via window.opener; noreferrer
  // keeps share slugs out of the payment host's referrer logs.
  link.rel = 'noopener noreferrer external';
  link.append(coffeeIcon(), document.createTextNode(label));

  slot.replaceChildren(link);
  slot.hidden = false;
  return true;
}
