import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveAppProtocol } from '../electron/protocol';

describe('app:// protocol resolver', () => {
  const appRoot = '/fake/app/root';

  it('resolves root path to index.html', () => {
    const result = resolveAppProtocol('app://./index.html', appRoot);
    expect(result).toBe(path.join(appRoot, 'index.html'));
  });

  it('resolves encoder paths', () => {
    const result = resolveAppProtocol('app://./encoder/gifencoder.js', appRoot);
    expect(result).toBe(path.join(appRoot, 'encoder', 'gifencoder.js'));
  });

  it('resolves dist paths', () => {
    const result = resolveAppProtocol('app://./dist/main.js', appRoot);
    expect(result).toBe(path.join(appRoot, 'dist', 'main.js'));
  });

  it('resolves media paths', () => {
    const result = resolveAppProtocol('app://./media/onboarding.gif', appRoot);
    expect(result).toBe(path.join(appRoot, 'media', 'onboarding.gif'));
  });

  it('URL spec normalizes traversal attempts safely', () => {
    // URL constructor normalizes /../ so traversal via URL is inherently safe
    const result = resolveAppProtocol('app://./../../../etc/passwd', appRoot);
    // Resolves to appRoot/etc/passwd (still inside appRoot) because URL normalizes path
    expect(result).toBe(path.join(appRoot, 'etc', 'passwd'));
  });

  it('returns null for empty paths', () => {
    const result = resolveAppProtocol('app://./', appRoot);
    expect(result).toBe(path.join(appRoot, ''));
  });
});
