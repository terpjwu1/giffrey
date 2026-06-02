import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

test.describe('Mic Toggle', () => {
  test('start screen shows mic toggle checkbox', async () => {
    const electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron', 'main.js')],
    });

    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');

      const micToggle = window.locator('.mic-toggle input[type="checkbox"]');
      await expect(micToggle).toBeVisible();
      await expect(micToggle).not.toBeChecked();

      await micToggle.check();
      await expect(micToggle).toBeChecked();

      await micToggle.uncheck();
      await expect(micToggle).not.toBeChecked();
    } finally {
      await electronApp.close();
    }
  });
});
