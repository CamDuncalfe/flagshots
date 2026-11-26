// Lays the screenshots out as one image per page: a row per flag, a column per state,
// the default state first in every row.
//
// The grid is an HTML page that Playwright screenshots, so Flagshots needs no image library.
// Inside that page, a short script compares each shot with the default shot pixel by pixel to
// find the area that changed, and every cell in the row shows that same area. A change as small
// as a button label stays readable in a pull request comment instead of shrinking into a
// full-page thumbnail.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// GitHub shows comment images at about this width, so the grid is laid out at it
// and rendered at twice the pixels to stay sharp.
const GRID_WIDTH = 880;

async function dataUrl(file, type = 'image/png') {
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
}

// The grid's labels are set in Inter, shipped with Flagshots (OFL licence), so the image looks
// the same on a Mac and on a Linux CI runner, which has no Inter or San Francisco.
async function interFont() {
  const css = createRequire(import.meta.url).resolve('@fontsource-variable/inter');
  return dataUrl(path.join(path.dirname(css), 'files', 'inter-latin-wght-normal.woff2'), 'font/woff2');
}

// rendered: one entry from renderPages (the page, its default shot and the other shots).
// Returns what the grid script measured for each row: the crop and whether anything changed.
export async function buildGrid(browser, rows, rendered, outFile) {
  const images = { default: await dataUrl(rendered.defaultFile) };
  for (const [identity, file] of rendered.files) images[identity] = await dataUrl(file);

  const data = {
    title: rendered.page.name,
    path: rendered.page.path,
    images,
    rows: rows.map((row) => ({
      flag: row.flag,
      description: row.description,
      experiment: row.experiment ?? null,
      cells: row.cells.map((cell) => ({
        label: cell.label,
        arm: cell.arm ?? null,
        quoted: typeof cell.value === 'string' && cell.enabled && cell.label === cell.value,
        isDefault: cell.isDefault,
        image: cell.identity ?? 'default',
      })),
    })),
  };

  const page = await browser.newPage({ viewport: { width: GRID_WIDTH, height: 600 }, deviceScaleFactor: 2 });
  try {
    // JSON inside a script tag: escape "<" so a flag value can't close the tag.
    // A function as the replacement, so a "$" in a flag value is left as it is.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    const font = await interFont();
    await page.setContent(GRID_HTML.replace('__DATA__', () => json).replace('__INTER__', () => font));
    await page.waitForFunction(() => document.body.dataset.done, null, { timeout: 60_000 });
    const result = await page.evaluate(() => window.gridResult);
    if (result.error) throw new Error(`The grid page failed: ${result.error}`);
    await page.screenshot({ path: outFile, fullPage: true });
    return result.rows;
  } finally {
    await page.close();
  }
}

const GRID_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Inter';
    font-weight: 100 900;
    src: url(__INTER__) format('woff2');
  }
  :root {
    --bg: #f6f5f1;
    --surface: #ffffff;
    --ink: #1b1a17;
    --muted: #5f5c55;
    --line: #dcdad3;
    --empty: #e9e8e3;
    font-family: 'Inter', sans-serif;
    color: var(--ink);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
  }
  body { margin: 0; width: ${GRID_WIDTH}px; }
  main { padding: 24px; }
  h1 { margin: 0 0 24px; font-size: 16px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
  code, .flag { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 code { font-size: 13px; font-weight: 400; color: var(--muted); }
  section + section { margin-top: 32px; }
  .flag { margin: 0; font-size: 14px; font-weight: 600; }
  .note { margin: 4px 0 0; font-size: 13px; line-height: 1.4; color: var(--muted); text-wrap: pretty; }
  .cells { display: grid; grid-template-columns: repeat(var(--columns), 1fr); gap: 16px; margin-top: 12px; }
  figure { margin: 0; min-width: 0; }
  .frame { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--surface); }
  canvas { display: block; width: 100%; height: auto; }
  figcaption { margin-top: 8px; font-size: 13px; line-height: 1.4; text-wrap: balance; overflow-wrap: anywhere; }
  .tag { color: var(--muted); }
  .arm { display: block; color: var(--muted); }
  .experiment { margin-top: 12px; padding-left: 12px; border-left: 2px solid var(--line); }
  .experiment p { margin: 0; font-size: 13px; line-height: 1.4; text-wrap: pretty; }
  .experiment .hypothesis { margin-top: 2px; color: var(--muted); }
</style>
</head>
<body>
<main id="grid"></main>
<script>
const data = __DATA__;

// Pixels whose colour channels all differ by less than this count as the same.
// It absorbs tiny anti-aliasing differences without hiding a real change.
const THRESHOLD = 24;
const PADDING = 32;
// A cropped shot is drawn at half its size or more, so a button label stays readable. A row with
// more shots than fit at that size wraps onto a second line.
const MIN_SCALE = 0.5;
const MAX_PER_LINE = 3;
const CONTENT_WIDTH = ${GRID_WIDTH} - 2 * 24;
const GAP = 16; // the gap between shots in .cells above
const MIN_WIDTH = 560;
const MIN_HEIGHT = 400;

function load(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load a screenshot'));
    img.src = src;
  });
}

function pixels(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// The smallest box around every pixel that differs between two screenshots.
// Where one page is taller than the other, the extra part counts as changed.
function changedBox(a, b) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let differs;
      if (x >= a.width || y >= a.height || x >= b.width || y >= b.height) {
        differs = true;
      } else {
        const i = (y * a.width + x) * 4;
        const j = (y * b.width + x) * 4;
        differs =
          Math.abs(a.data[i] - b.data[j]) > THRESHOLD ||
          Math.abs(a.data[i + 1] - b.data[j + 1]) > THRESHOLD ||
          Math.abs(a.data[i + 2] - b.data[j + 2]) > THRESHOLD;
      }
      if (differs) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
}

// Pads the box and keeps it at least MIN_WIDTH by MIN_HEIGHT, so there's some page around the
// change, then keeps it inside the page.
function cropAround(box, pageWidth, pageHeight) {
  let left = box.left - PADDING, right = box.right + PADDING;
  let top = box.top - PADDING, bottom = box.bottom + PADDING;
  if (right - left < MIN_WIDTH) { const grow = (MIN_WIDTH - (right - left)) / 2; left -= grow; right += grow; }
  if (bottom - top < MIN_HEIGHT) { const grow = (MIN_HEIGHT - (bottom - top)) / 2; top -= grow; bottom += grow; }
  if (left < 0) { right -= left; left = 0; }
  if (top < 0) { bottom -= top; top = 0; }
  right = Math.min(right, pageWidth);
  bottom = Math.min(bottom, pageHeight);
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

// How far an edge of the crop may move to find a blank line, and the room left around the content.
const SNAP_LIMIT = 240;
const MARGIN = 24;
// A blank line allows far less colour difference than THRESHOLD: a card's 1 px border, smeared
// over two pixel columns by anti-aliasing, has to count as content.
const BLANK_THRESHOLD = 4;

// Whether a line of pixels is one flat colour in every shot of the row, like the gap between two
// cards. A crop edge on a line like that cuts nothing in half. Past the edge of a page counts as blank.
function blankLine(shots, vertical, at, from, to) {
  const first = shots[0];
  if (vertical ? at <= 0 || at >= first.width : at <= 0 || at >= first.height) return true;
  const base = (vertical ? from * first.width + at : at * first.width + from) * 4;
  for (const shot of shots) {
    for (let k = from; k < to; k++) {
      const x = vertical ? at : k;
      const y = vertical ? k : at;
      if (x >= shot.width || y >= shot.height) return false;
      const i = (y * shot.width + x) * 4;
      if (
        Math.abs(shot.data[i] - first.data[base]) > BLANK_THRESHOLD ||
        Math.abs(shot.data[i + 1] - first.data[base + 1]) > BLANK_THRESHOLD ||
        Math.abs(shot.data[i + 2] - first.data[base + 2]) > BLANK_THRESHOLD
      ) return false;
    }
  }
  return true;
}

// Fits the crop to whole things on the page. Each edge first moves to the nearest blank line,
// outwards or inwards, so the crop holds whole cards and buttons instead of slicing through one.
// Then each edge moves in past any empty page to the first content, and back out by MARGIN
// where the page is blank there.
// An edge never moves inside the area that changed, and with no blank line within SNAP_LIMIT
// it stays where it was.
function fitToContent(crop, box, shots) {
  const width = shots[0].width;
  const height = shots[0].height;
  const e = { left: crop.x, top: crop.y, right: crop.x + crop.width, bottom: crop.y + crop.height };
  // For each edge: which way is out, how far in it may go, and whether its line runs up and down.
  const sides = {
    left: { out: -1, limit: box.left, vertical: true },
    right: { out: 1, limit: box.right, vertical: true },
    top: { out: -1, limit: box.top, vertical: false },
    bottom: { out: 1, limit: box.bottom, vertical: false },
  };
  const blank = (side, at) => {
    const { vertical } = sides[side];
    return blankLine(shots, vertical, at, vertical ? e.top : e.left, vertical ? e.bottom : e.right);
  };
  // Whether a line sits outside the changed area, so the edge may stop there.
  const outside = (side, at) => sides[side].out * (at - sides[side].limit) >= 0;

  for (const side of ['left', 'right', 'top', 'bottom']) {
    const { out } = sides[side];
    for (let d = 0; d <= SNAP_LIMIT; d++) {
      if (blank(side, e[side] + out * d)) { e[side] += out * d; break; }
      const inner = e[side] - out * d;
      if (outside(side, inner) && blank(side, inner)) { e[side] = inner; break; }
    }
  }
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const { out } = sides[side];
    while (outside(side, e[side] - out) && blank(side, e[side] - out)) e[side] -= out;
    for (let k = 0; k < MARGIN && blank(side, e[side] + out); k++) e[side] += out;
  }

  const left = Math.max(0, e.left), top = Math.max(0, e.top);
  const right = Math.min(width, e.right), bottom = Math.min(height, e.bottom);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function build() {
  const imgs = {};
  const px = {};
  for (const [key, src] of Object.entries(data.images)) {
    imgs[key] = await load(src);
    px[key] = pixels(imgs[key]);
  }

  const grid = document.getElementById('grid');
  const title = el('h1', null, data.title + ' ');
  title.append(el('code', null, data.path));
  grid.append(title);

  const columns = Math.max(...data.rows.map((r) => r.cells.length));
  const measured = [];

  for (const row of data.rows) {
    // One crop for the whole row: the union of what changed in each cell against the default.
    let union = null;
    for (const cell of row.cells) {
      if (cell.image === 'default') continue;
      const box = changedBox(px.default, px[cell.image]);
      if (!box) continue;
      union = union
        ? { left: Math.min(union.left, box.left), top: Math.min(union.top, box.top),
            right: Math.max(union.right, box.right), bottom: Math.max(union.bottom, box.bottom) }
        : box;
    }
    const pageWidth = Math.max(...row.cells.map((c) => px[c.image].width));
    const pageHeight = Math.max(...row.cells.map((c) => px[c.image].height));
    // When the change covers most of the page (a colour scheme, a new layout), the row shows
    // whole pages: a crop that large only cuts off the edges.
    const whole = { x: 0, y: 0, width: pageWidth, height: pageHeight };
    const shots = row.cells.map((c) => px[c.image]);
    let crop = union ? fitToContent(cropAround(union, pageWidth, pageHeight), union, shots) : whole;
    if (crop.width * crop.height > 0.55 * pageWidth * pageHeight) crop = whole;
    measured.push({ flag: row.flag, changed: Boolean(union), crop });

    const section = el('section');
    section.append(el('p', 'flag', row.flag));
    const note = [row.description, union ? '' : 'No visible change on this page.'].filter(Boolean).join(' ');
    if (note) section.append(el('p', 'note', note));
    if (row.experiment) {
      // The experiment this flag is in, read from Flagsmith: its name, whether it has started,
      // and the hypothesis the team wrote for it.
      const box = el('div', 'experiment');
      box.append(el('p', null, 'Experiment \u201c' + row.experiment.name + '\u201d, ' + row.experiment.status));
      if (row.experiment.hypothesis) box.append(el('p', 'hypothesis', row.experiment.hypothesis));
      section.append(box);
    }

    const cells = el('div', 'cells');
    // Three shots a line at most, the same width in every row, so whole pages stay big enough to
    // compare. A cropped row takes fewer a line when it needs them bigger to stay at MIN_SCALE.
    let perLine = Math.min(columns, MAX_PER_LINE);
    if (crop !== whole) {
      const scale = (n) => (CONTENT_WIDTH - GAP * (n - 1)) / n / crop.width;
      while (perLine > 1 && scale(perLine) < MIN_SCALE) perLine--;
    }
    cells.style.setProperty('--columns', perLine);
    for (const cell of row.cells) {
      const figure = el('figure');
      const frame = el('div', 'frame');
      const canvas = document.createElement('canvas');
      canvas.width = crop.width;
      canvas.height = crop.height;
      const ctx = canvas.getContext('2d');
      // A shorter page leaves part of the crop empty; it's filled with a flat grey.
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--empty');
      ctx.fillRect(0, 0, crop.width, crop.height);
      ctx.drawImage(imgs[cell.image], -crop.x, -crop.y);
      frame.append(canvas);
      figure.append(frame);

      // Text values go in quotes so a reader can see exactly what the flag holds.
      const caption = el('figcaption', null, cell.quoted ? '\u201c' + cell.label + '\u201d' : cell.label);
      if (cell.isDefault) {
        caption.append(' ');
        caption.append(el('span', 'tag', '(default)'));
      }
      if (cell.arm) caption.append(el('span', 'arm', cell.arm));
      figure.append(caption);
      cells.append(figure);
    }
    section.append(cells);
    grid.append(section);
  }
  await document.fonts.ready;
  return measured;
}

build()
  .then((rows) => { window.gridResult = { rows }; })
  .catch((err) => { window.gridResult = { error: err.message }; })
  .finally(() => { document.body.dataset.done = 'true'; });
</script>
</body>
</html>`;
