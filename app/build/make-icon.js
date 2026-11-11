// Draws the app icon (build/icon.png, 512x512): a blue rounded square with a
// white padlock, plus the tray icons: gray when off, a green dot when on and
// an amber dot while connecting. Plain Node, no image libraries.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256, SS = 4; // drawing size, supersampling
const OUT = 512; // output size (macOS needs at least 512)
const K = S / OUT;

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function sample(x, y, o) {
  // returns [r,g,b,a]
  if (o.dot) {
    const d = Math.hypot(x - 196, y - 196);
    if (d <= 50) return o.dot;
    if (d <= 64) return [0, 0, 0, 0]; // gap around the dot
  }
  if (!inRoundRect(x, y, 8, 8, 248, 248, 56)) return [0, 0, 0, 0];
  // padlock body
  if (inRoundRect(x, y, 70, 118, 186, 210, 16)) {
    // keyhole
    const kh = (x - 128) ** 2 + (y - 152) ** 2 <= 13 * 13 || (Math.abs(x - 128) <= 6 && y >= 152 && y <= 182);
    if (!kh) return [255, 255, 255, 255];
  }
  // shackle: ring between radius 30 and 46 centered (128,118), upper half + legs
  const d = Math.hypot(x - 128, y - 106);
  if (y <= 106 && d >= 30 && d <= 46) return [255, 255, 255, 255];
  if (y > 106 && y < 120 && ((x >= 82 && x <= 98) || (x >= 158 && x <= 174))) return [255, 255, 255, 255];
  // background gradient
  const t = y / S;
  const [a, b] = o.bg;
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).concat(255);
}

const BLUE = [[37, 99, 235], [29, 78, 216]];
const GRAY = [[120, 128, 140], [90, 98, 110]];

function draw(o) {
const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
      const p = sample((x + (i + 0.5) / SS) * K, (y + (j + 0.5) / SS) * K, o);
      r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
    }
    const k = y * (OUT * 4 + 1) + 1 + x * 4;
    raw[k] = a ? r / a : 0; raw[k + 1] = a ? g / a : 0; raw[k + 2] = a ? b / a : 0; raw[k + 3] = a / (SS * SS);
  }
}
return raw;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = (raw) => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
const out = {
  'icon.png': { bg: BLUE },
  'tray-off.png': { bg: GRAY },
  'tray-on.png': { bg: BLUE, dot: [34, 197, 94, 255] },
  'tray-busy.png': { bg: BLUE, dot: [245, 158, 11, 255] },
};
for (const [file, o] of Object.entries(out)) fs.writeFileSync(path.join(__dirname, file), png(draw(o)));
console.log('icons written');
