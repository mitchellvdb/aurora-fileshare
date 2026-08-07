import qrcode from 'qrcode-generator';

/**
 * Renders a QR code as a single SVG path. Building it from DOM nodes rather
 * than an HTML string keeps us clear of innerHTML entirely.
 */
export function renderQr(text: string, size = 200): SVGSVGElement {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 2;
  const dimension = count + quiet * 2;

  const parts: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${dimension} ${dimension}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code for this share link');
  svg.setAttribute('shape-rendering', 'crispEdges');

  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', String(dimension));
  background.setAttribute('height', String(dimension));
  background.setAttribute('fill', '#ffffff');
  svg.append(background);

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', parts.join(''));
  path.setAttribute('fill', '#0b1220');
  svg.append(path);

  return svg;
}
