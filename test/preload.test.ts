import { describe, it, expect } from 'vitest';
import { getExposedAPI } from '../electron/preload-api';

describe('preload API surface', () => {
  it('exposes saveFile function', () => {
    const api = getExposedAPI();
    expect(api).toHaveProperty('saveFile');
    expect(typeof api.saveFile).toBe('function');
  });

  it('exposes saveGif convenience method', () => {
    const api = getExposedAPI();
    expect(api).toHaveProperty('saveGif');
    expect(typeof api.saveGif).toBe('function');
  });

  it('exposes saveVideo convenience method', () => {
    const api = getExposedAPI();
    expect(api).toHaveProperty('saveVideo');
    expect(typeof api.saveVideo).toBe('function');
  });

  it('does not expose backup recorder chunk append API', () => {
    const api = getExposedAPI();
    expect(api).not.toHaveProperty('appendRecordingChunk');
  });
});
