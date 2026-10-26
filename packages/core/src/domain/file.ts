import { sha256 } from './sha256.js';

export interface FileLocation {
  storeKind: 'local' | 'drive';
  locator: string;
  ownership: 'brain' | 'external';
}

export function contentHashOfBytes(bytes: Uint8Array): string {
  return 'sha256:' + Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function brainLocator(hex: string, bytes: Uint8Array): string {
  const starts = (...head: number[]) => head.every((b, i) => bytes[i] === b);
  const ext = starts(137,80,78,71,13,10,26,10) ? '.png'
    : starts(255,216,255) ? '.jpg'
    : starts(71,73,70,56,55,97) || starts(71,73,70,56,57,97) ? '.gif'
    : starts(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 ? '.webp' : '';
  return `${hex.slice(0,2)}/${hex.slice(2,4)}/${hex}${ext}`;
}

export function isBrainLocator(locator: string): boolean {
  const match = /^([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})(?:\.(?:png|jpg|gif|webp))?$/.exec(locator);
  return match !== null && match[0] === locator && match[1] === match[3]?.slice(0,2) && match[2] === match[3]?.slice(2,4);
}

const controlCharacter = /[\u0000-\u001f\u007f]/;

function absoluteSegments(path: string): string[] | null {
  if (!path.startsWith('/') || controlCharacter.test(path)) return null;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments;
}

/** A portable local source location strictly below the supplied home. */
export function externalLocator(path: string, home: string): string | null {
  const segments = absoluteSegments(path);
  const homeSegments = absoluteSegments(home);
  if (segments === null || homeSegments === null || segments.length <= homeSegments.length
    || !homeSegments.every((segment, index) => segments[index] === segment)) return null;
  return '~/' + segments.slice(homeSegments.length).join('/');
}

export function isExternalLocator(locator: string): boolean {
  return locator.startsWith('~/') && !controlCharacter.test(locator)
    && locator.slice(2).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function externalPath(locator: string, home: string): string | null {
  const homeSegments = absoluteSegments(home);
  if (!isExternalLocator(locator) || homeSegments === null) return null;
  return '/' + [...homeSegments, locator.slice(2)].join('/');
}
