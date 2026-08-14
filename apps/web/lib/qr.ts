import qrcode from 'qrcode-generator';

/**
 * QR geometry for the desktop half of the WhatsApp handshake (issue #84).
 *
 * SERVER-SIDE ONLY, and that is the point of returning geometry rather than
 * markup: the caller renders `<svg viewBox={viewBox}><path d={path} /></svg>`,
 * so the encoder never enters the browser bundle and nothing here needs
 * `dangerouslySetInnerHTML`. qrcode-generator ships `createSvgTag()`, which
 * returns a markup STRING and would require exactly that — declined.
 */

/**
 * Four modules of blank margin, mandated by the QR specification. Many scanners
 * will not lock onto a code without it. It lives inside `viewBox` rather than
 * in the component's padding so a caller cannot render a code without it.
 */
const QUIET_ZONE = 4;

export interface QrGeometry {
  /** Modules per side, excluding the quiet zone. Always 4n+17. */
  count: number;
  /** One `M{col} {row}h1v1h-1z` subpath per dark module, concatenated. */
  path: string;
  /** `-4 -4 {count+8} {count+8}` — the grid plus the quiet zone. */
  viewBox: string;
}

/**
 * @param text What the code encodes. For this feature, the `wa.me` URL from
 *   `buildWhatsAppLink` — never anything tenant-specific: this code is
 *   identical for every manager in a given locale.
 *
 * Type number 0 lets the library pick the smallest version that fits.
 * Error-correction level 'M' (~15% recoverable) is the usual choice for a code
 * displayed on a clean screen; 'H' would make the code denser and harder to
 * scan from a phone held at arm's length, for redundancy a screen does not need.
 */
export function qrGeometry(text: string): QrGeometry {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }

  return {
    count,
    path: parts.join(''),
    viewBox: `${-QUIET_ZONE} ${-QUIET_ZONE} ${count + QUIET_ZONE * 2} ${count + QUIET_ZONE * 2}`,
  };
}
