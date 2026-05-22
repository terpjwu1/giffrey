import { describe, it, expect } from 'vitest';
import { getWindowConfig, getProtocolConfig } from '../electron/config';

describe('Electron main process config', () => {
  it('window config has correct dimensions', () => {
    const config = getWindowConfig();
    expect(config.width).toBe(1200);
    expect(config.height).toBe(800);
  });

  it('window config enables web security', () => {
    const config = getWindowConfig();
    expect(config.webPreferences.contextIsolation).toBe(true);
    expect(config.webPreferences.nodeIntegration).toBe(false);
  });

  it('window config specifies preload script', () => {
    const config = getWindowConfig();
    expect(config.webPreferences.preload).toContain('preload.js');
  });

  it('protocol config uses app scheme', () => {
    const config = getProtocolConfig();
    expect(config.scheme).toBe('app');
    expect(config.privileges.standard).toBe(true);
    expect(config.privileges.secure).toBe(true);
  });
});
