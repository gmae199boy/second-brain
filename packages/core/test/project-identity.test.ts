import { describe, expect, it } from 'vitest';
import { normalizeRemoteIdentity } from '../src/domain/project-identity.js';

/**
 * The one normalizing function of AD-12, against the rows of the story's
 * matrix. What is being held is a single claim: two clones of the same
 * repository come out with the same name, and two different repositories never
 * do.
 *
 * Neutral host names only, because the repository is public (Conventions).
 */

describe('normalizeRemoteIdentity on the shapes a remote is written in', () => {
  it.each([
    // The same repository, four ways of reaching it.
    ['https://demo.example/owner/repo.git', 'demo.example/owner/repo'],
    ['git@demo.example:owner/repo.git', 'demo.example/owner/repo'],
    ['ssh://git@demo.example:22/owner/repo', 'demo.example/owner/repo'],
    ['git://demo.example/owner/repo.git', 'demo.example/owner/repo'],
    // The host is a server and a server's name has no case; the path is a
    // repository and on a case-sensitive forge its case is its identity.
    ['git@DEMO.Example:Owner/Repo.git', 'demo.example/Owner/Repo'],
    ['https://demo.example/OWNER/repo', 'demo.example/OWNER/repo'],
    // A trailing slash, a trailing `.git`, and both at once.
    ['https://demo.example/owner/repo/', 'demo.example/owner/repo'],
    ['https://demo.example/owner/repo.git/', 'demo.example/owner/repo'],
    // Empty segments are nothing: a doubled slash is still one separator.
    ['https://demo.example//owner//repo.git', 'demo.example/owner/repo'],
    // A sub-group stays whole, or two repositories of one group would merge.
    ['git@demo.example:group/sub/repo.git', 'demo.example/group/sub/repo'],
    // The other schemes AD-12 names.
    ['git+ssh://git@demo.example/owner/repo.git', 'demo.example/owner/repo'],
    ['ssh+git://git@demo.example/owner/repo.git', 'demo.example/owner/repo'],
    ['http://demo.example/owner/repo', 'demo.example/owner/repo'],
    // The scheme itself is spelled however the clone spelled it.
    ['HTTPS://Demo.Example/owner/repo.git', 'demo.example/owner/repo'],
    // An IPv6 literal keeps its brackets, with or without a port.
    ['ssh://git@[2001:db8::1]:22/owner/repo.git', '[2001:db8::1]/owner/repo'],
    // A path that is nothing but `.git` leaves the segment in front of it as
    // the repository, which is what a bare clone of `repo.git` is called.
    ['https://demo.example/owner/repo/.git', 'demo.example/owner/repo'],
    // A single-segment path is a repository too: not every host has owners.
    ['ssh://git@demo.example/repo.git', 'demo.example/repo'],
    // Surrounding whitespace is how a remote read off a line arrives.
    ['  https://demo.example/owner/repo.git\n', 'demo.example/owner/repo'],
  ])('reads %s as %s', (url, identity) => {
    expect(normalizeRemoteIdentity(url)).toBe(identity);
  });

  it('gives one name to an ssh clone and an https clone of one repository', () => {
    expect(normalizeRemoteIdentity('git@demo.example:owner/repo.git')).toBe(
      normalizeRemoteIdentity('https://demo.example/owner/repo'),
    );
  });

  it('gives two names to two repositories of the same owner', () => {
    expect(normalizeRemoteIdentity('https://demo.example/owner/repo')).not.toBe(
      normalizeRemoteIdentity('https://demo.example/owner/notes'),
    );
  });
});

describe('normalizeRemoteIdentity and the secrets a remote URL carries', () => {
  it.each([
    'https://brain-owner:s3cr3t-token@demo.example/owner/repo.git',
    'https://s3cr3t-token@demo.example/owner/repo.git',
    'ssh://brain-owner:s3cr3t-token@demo.example:22/owner/repo',
  ])('keeps neither the user nor the password of %s', (url) => {
    const identity = normalizeRemoteIdentity(url);

    expect(identity).toBe('demo.example/owner/repo');
    // Stated as its own assertion, because this is the one that matters: the
    // identity goes into a row, and a token in a row is a token on disk
    // (NFR-1).
    expect(identity).not.toContain('s3cr3t-token');
    expect(identity).not.toContain('brain-owner');
    expect(identity).not.toContain('@');
    expect(identity).not.toContain(':');
  });
});

describe('normalizeRemoteIdentity on a remote that names no repository', () => {
  it.each([
    // No host at all: a path on one machine is no identity two machines can
    // agree on, so the caller falls back to the git common directory.
    ['a file URL', 'file:///srv/repo.git'],
    ['an absolute path', '/srv/repo.git'],
    ['a relative path', '../repo'],
    ['a path with no colon in it', 'srv-repo.git'],
    // A host with nothing behind it.
    ['a host and no path', 'demo.example:'],
    ['a host and a slash', 'https://demo.example/'],
    ['a host alone', 'https://demo.example'],
    ['a path of empty segments', 'https://demo.example///'],
    // Nothing, and a scheme this function does not read.
    ['the empty string', ''],
    ['whitespace', '   '],
    ['an unknown scheme', 'ftp://demo.example/owner/repo.git'],
    ['a scheme with no host', 'ssh:///owner/repo.git'],
    // A path whose only segment is `.git` names nothing.
    ['a bare `.git`', 'https://demo.example/.git'],
    // A bracket that never closes is not an authority.
    ['an unterminated IPv6 literal', 'ssh://git@[2001:db8::1/owner/repo.git'],
  ])('answers null for %s', (_name, url) => {
    expect(normalizeRemoteIdentity(url)).toBeNull();
  });

  it('never answers an identity that could be mistaken for a local one', () => {
    // The fallback identity is an absolute path, so it begins with `/`. A
    // normalized remote begins with a host, and the two can never collide
    // (AD-12).
    expect(normalizeRemoteIdentity('https://demo.example/owner/repo')?.startsWith('/')).toBe(
      false,
    );
  });
});
