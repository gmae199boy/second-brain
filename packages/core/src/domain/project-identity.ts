/**
 * The one normalizing function of AD-12: a git remote URL as the identity of a
 * project, or `null` for a remote that names no host.
 *
 * It is here, in the domain, and it is pure. Two people who cloned the same
 * repository — one over ssh, one over https, one of them through a token in the
 * URL — must land on the same `projects` row, and the only way that holds is if
 * exactly one function decides what a remote is called. A second rule anywhere
 * (in the adapter, in the CLI, in a migration) would split the same repository
 * into two projects and nothing would ever join them again.
 */

/**
 * The schemes a remote may carry. `file://` is deliberately not among them: a
 * remote with no host is a path on one machine, and a path is not an identity
 * two machines can agree on — the caller falls back to the git common
 * directory, which says plainly that it is local (AD-12).
 */
const SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git']);

/** How a URL announces its scheme, and the only place `://` is allowed. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** A port at the end of an authority: `:22`, and nothing else. */
const PORT = /:\d*$/;

/**
 * `host/path` for a remote URL, or `null`.
 *
 * The host is lower-cased, because a host name is case-insensitive and
 * `GitHub.com` and `github.com` are one server. The path is left exactly as it
 * came, because on a case-sensitive forge `Owner/Repo` and `owner/repo` are two
 * repositories, and folding them together would merge two projects for good
 * (Decision 2026-10-18). The scheme, the user, the password and the port are
 * dropped: they say how this clone reaches the server, not which repository it
 * is. One trailing `.git` and any trailing `/` go too.
 *
 * It reads `https://`, `http://`, `ssh://`, `git://`, `git+ssh://`,
 * `ssh+git://` and the scp shape `[user@]host:path`, so
 * `git@GitHub.com:o/r.git`, `ssh://git@github.com:22/o/r` and
 * `https://tok:x@github.com/o/r.git/` all come out as `github.com/o/r`.
 *
 * `null` means "this remote is no identity": no host, no path, or a scheme
 * that carries neither — `file:///srv/r.git`, `/srv/r.git`, `host:`, `''`.
 */
export function normalizeRemoteIdentity(url: string): string | null {
  const split = splitRemote(url.trim());
  if (split === null) return null;

  const host = hostOf(split.authority);
  if (host === null) return null;
  const path = pathOf(split.path);
  if (path === null) return null;
  return `${host}/${path}`;
}

/** The authority and the path of a remote, whichever shape it is written in. */
function splitRemote(url: string): { authority: string; path: string } | null {
  if (url === '') return null;

  const scheme = SCHEME.exec(url);
  if (scheme !== null) {
    // A scheme this function does not read is not a remote it can name, which
    // is how `file://` lands on `null` rather than on a host called `srv`.
    if (!SCHEMES.has((scheme[1] ?? '').toLowerCase())) return null;
    const rest = url.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    return slash < 0
      ? { authority: rest, path: '' }
      : { authority: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }
  // Anything else with a `://` in it carries a scheme spelled in a way the
  // pattern above does not accept, so it is not a remote either.
  if (url.includes('://')) return null;

  // The scp shape: the first colon separates the host from the path. A string
  // with no colon is a local path, and a local path is not an identity.
  const colon = url.indexOf(':');
  if (colon < 0) return null;
  return { authority: url.slice(0, colon), path: url.slice(colon + 1) };
}

/**
 * The host of an authority, lower-cased, with the user, the password and the
 * port taken off. An IPv6 literal keeps its brackets, because that is how it is
 * written everywhere a host is written.
 */
function hostOf(authority: string): string | null {
  // Everything up to the last `@` is `user` or `user:password`, and a password
  // in a remote URL is a secret: it must not reach a row (NFR-1).
  const at = authority.lastIndexOf('@');
  const hostAndPort = at < 0 ? authority : authority.slice(at + 1);

  const host = hostAndPort.startsWith('[')
    ? bracketedHost(hostAndPort)
    : hostAndPort.replace(PORT, '');
  if (host === null || host === '') return null;
  return host.toLowerCase();
}

/** An IPv6 literal, `[::1]` or `[::1]:22`, up to and including the bracket. */
function bracketedHost(hostAndPort: string): string | null {
  const close = hostAndPort.indexOf(']');
  if (close < 0) return null;
  const rest = hostAndPort.slice(close + 1);
  if (rest !== '' && PORT.exec(rest) === null) return null;
  return hostAndPort.slice(0, close + 1);
}

/**
 * The path of a remote as the identity spells it: the non-empty segments joined
 * by one `/`, with one trailing `.git` dropped. A sub-group stays whole, so
 * `host/g/sub/r` is its own project and not `host/g`.
 */
function pathOf(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  const last = segments.pop();
  if (last === undefined) return null;

  const named = last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
  // A last segment that was nothing but `.git` leaves no name behind, so the
  // segment in front of it is the repository.
  if (named !== '') segments.push(named);
  return segments.length === 0 ? null : segments.join('/');
}
