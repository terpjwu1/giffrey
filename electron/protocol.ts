import path from 'path';

export function resolveAppProtocol(url: string, appRoot: string): string | null {
  const parsed = new URL(url);
  const relativePath = decodeURIComponent(parsed.host + parsed.pathname).replace(/^\.?\/?/, '');

  const resolved = path.resolve(appRoot, relativePath);

  if (!resolved.startsWith(appRoot + path.sep) && resolved !== appRoot) {
    return null;
  }

  return resolved;
}
