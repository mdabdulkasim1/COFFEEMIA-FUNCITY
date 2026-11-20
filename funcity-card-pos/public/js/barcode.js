// Code 128 (subset B) barcode as inline SVG. No library needed; any 1D USB barcode scanner reads it.
const PATTERNS = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
const START_B = 104, STOP = 106;

export function code128Values(text) {
  const vals = [START_B];
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Character not allowed in barcode: ${ch}`);
    vals.push(c - 32);
  }
  let sum = START_B;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, STOP);
  return vals;
}
export const code128Widths = text => code128Values(text).map(v => PATTERNS[v]).join('');

export function code128Svg(text, { height = 44, module = 2, showText = true, font = 13 } = {}) {
  const widths = code128Widths(text);
  const quiet = 10 * module;
  let x = quiet; const bars = [];
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]) * module;
    if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);
    x += w;
  }
  const W = x + quiet, H = height + (showText ? font + 6 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" role="img" aria-label="${text}">
    <rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${bars.join('')}</g>
    ${showText ? `<text x="${W / 2}" y="${H - 3}" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${font}" font-weight="700" letter-spacing="3" fill="#000">${text}</text>` : ''}</svg>`;
}
