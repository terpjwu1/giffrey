import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

test.describe('App Launch', () => {
  test('app starts and shows the start screen', async () => {
    const electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron', 'main.js')],
    });

    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const title = await window.title();
    expect(title).toBeDefined();

    const body = await window.locator('#app').textContent();
    expect(body).toContain('giffrey');

    await electronApp.close();
  });

  test('ffmpeg binary exists on disk', async () => {
    const fs = await import('fs');
    const ffmpegPath = require('ffmpeg-static') as string;

    expect(ffmpegPath).toBeTruthy();
    expect(fs.existsSync(ffmpegPath)).toBe(true);
    expect(fs.statSync(ffmpegPath).mode & 0o111).toBeGreaterThan(0); // executable
  });
});
