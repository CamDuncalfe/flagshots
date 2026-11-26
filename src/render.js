// Opens each page of the app in headless Chromium, once per shot, and saves a full-page PNG.
//
// A shot with an identity loads the page with ?flagshots_identity=<name> (the parameter name is
// configurable). The app passes that name to the Flagsmith SDK, and Flagsmith answers with the
// override for that identity.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Each shot gets a new browser context: its own cookies and storage, so nothing the SDK saved
// for one identity can show up in the next screenshot.
async function shoot(browser, url, file, options) {
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  try {
    await page.goto(url, { waitUntil: 'load' });
    if (options.readySelector) {
      // The app marks the page once it has drawn with its flags. Waiting for network quiet alone
      // can fire before the flags arrive.
      await page.waitForSelector(options.readySelector, { state: 'attached', timeout: options.timeoutMs });
    } else {
      await page.waitForLoadState('networkidle', { timeout: options.timeoutMs });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  } catch (err) {
    const extra = errors.length ? `\nThe page logged: ${errors.join(' | ')}` : '';
    throw new Error(`Could not take the screenshot of ${url}: ${err.message.split('\n')[0]}${extra}`);
  } finally {
    await context.close();
  }
  return { file, errors };
}

// Returns, for each page, the file of the default shot and a file for each cell in each row.
export async function renderPages(browser, rows, config, outDir) {
  const results = [];
  for (const pageConfig of config.pages) {
    const dir = path.join(outDir, pageConfig.slug);
    await mkdir(dir, { recursive: true });

    const shotUrl = (identity) => {
      const url = new URL(pageConfig.path, config.baseUrl);
      if (identity) url.searchParams.set(config.identityParam, identity);
      return url.href;
    };

    const defaultShot = await shoot(browser, shotUrl(null), path.join(dir, 'default.png'), config);
    const files = new Map();
    for (const row of rows) {
      for (const cell of row.cells) {
        if (!cell.identity) continue;
        const shot = await shoot(browser, shotUrl(cell.identity), path.join(dir, `${cell.identity}.png`), config);
        files.set(cell.identity, shot.file);
        console.log(`  ${pageConfig.name}: ${row.flag} = ${cell.label}`);
      }
    }
    results.push({ page: pageConfig, defaultFile: defaultShot.file, files });
  }
  return results;
}
