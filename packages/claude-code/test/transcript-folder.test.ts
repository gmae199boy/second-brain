import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_HARNESS } from '../src/parser.js';
import { claudeCodeTranscriptFolder } from '../src/transcript-folder.js';

/**
 * The folder adapter against real directories: which files it reports as
 * sessions, and above all which ones it does not.
 *
 * No test here touches a real `~/.claude`: every one of them makes its own
 * temporary configuration folder and hands the path in (Boundaries).
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-claude-folder-'));
  directories.push(directory);
  return directory;
}

/** A transcript with some content, under one project folder. */
async function transcript(
  configDir: string,
  project: string,
  sessionId: string,
  content = '{"type":"user"}\n',
): Promise<string> {
  const folder = join(configDir, 'projects', project);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${sessionId}.jsonl`);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('claudeCodeTranscriptFolder', () => {
  it('reports one session per transcript, with its size and its instant', async () => {
    const configDir = await scratch();
    const first = await transcript(configDir, '-demo-a', 'session-a', 'a'.repeat(10));
    const second = await transcript(configDir, '-demo-b', 'session-b', 'bb');

    const listed = await claudeCodeTranscriptFolder({ configDir }).list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const byId = new Map(listed.files.map((file) => [file.harnessSessionId, file]));
    expect([...byId.keys()].sort()).toEqual(['session-a', 'session-b']);
    expect(byId.get('session-a')).toMatchObject({
      harness: CLAUDE_CODE_HARNESS,
      path: first,
      sizeBytes: 10,
    });
    expect(byId.get('session-b')).toMatchObject({ path: second, sizeBytes: 2 });
    expect(byId.get('session-a')?.modifiedAt).toBeInstanceOf(Date);
  });

  it('is the file name that names the session, not the folder', async () => {
    // The folder name is the working directory with its separators replaced,
    // and nothing here reads it: so its shape can change between editor
    // versions without anything in this adapter caring.
    const configDir = await scratch();
    await transcript(configDir, '-Users-someone-very-odd--name', 'the-session');

    const listed = await claudeCodeTranscriptFolder({ configDir }).list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files.map((file) => file.harnessSessionId)).toEqual(['the-session']);
  });

  it('counts neither a delegated run nor a tool result nor anything deeper', async () => {
    // A delegated run is not a session: the parser reports its final report as
    // one message of the main conversation (AD-4), so counting one here would
    // create a session row for a conversation that never happened.
    const configDir = await scratch();
    await transcript(configDir, '-demo-a', 'session-a');
    const project = join(configDir, 'projects', '-demo-a');
    await mkdir(join(project, 'subagents'), { recursive: true });
    await writeFile(join(project, 'subagents', 'agent-x.jsonl'), '{}\n', 'utf8');
    await mkdir(join(project, 'tool-results'), { recursive: true });
    await writeFile(join(project, 'tool-results', 'x.txt'), 'out', 'utf8');
    await mkdir(join(project, 'deeper', 'still'), { recursive: true });
    await writeFile(join(project, 'deeper', 'still', 'session-z.jsonl'), '{}\n', 'utf8');

    const listed = await claudeCodeTranscriptFolder({ configDir }).list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files.map((file) => file.harnessSessionId)).toEqual(['session-a']);
  });

  it('leaves out a name that is not a transcript, and a folder that looks like one', async () => {
    const configDir = await scratch();
    await transcript(configDir, '-demo-a', 'session-a');
    const project = join(configDir, 'projects', '-demo-a');
    await writeFile(join(project, 'notes.txt'), 'x', 'utf8');
    await writeFile(join(project, '.jsonl'), 'x', 'utf8');
    // A directory whose name ends in `.jsonl` is not a transcript: the `stat`
    // is what tells them apart, and a listing that trusted the name would hand
    // a folder to the reader as a session.
    await mkdir(join(project, 'folder.jsonl'), { recursive: true });

    const listed = await claudeCodeTranscriptFolder({ configDir }).list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files.map((file) => file.harnessSessionId)).toEqual(['session-a']);
  });

  it('follows a symbolic link to a transcript, because that is still a transcript', async () => {
    const configDir = await scratch();
    const real = await transcript(configDir, '-demo-a', 'session-a', 'abc');
    const project = join(configDir, 'projects', '-demo-b');
    await mkdir(project, { recursive: true });
    await symlink(real, join(project, 'session-b.jsonl'));

    const listed = await claudeCodeTranscriptFolder({ configDir }).list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files.map((file) => file.harnessSessionId).sort()).toEqual([
      'session-a',
      'session-b',
    ]);
  });

  it('answers an empty list when there is no projects folder at all', async () => {
    // A machine where the editor has never run, or a brain installed before
    // it: nothing to collect, and nothing broken either.
    const configDir = await scratch();

    expect(await claudeCodeTranscriptFolder({ configDir }).list()).toEqual({
      ok: true,
      files: [],
    });
  });

  it('answers an empty list when the configuration folder itself is not there', async () => {
    const configDir = join(await scratch(), 'never-made');

    expect(await claudeCodeTranscriptFolder({ configDir }).list()).toEqual({
      ok: true,
      files: [],
    });
  });

  it('says so when the projects folder cannot be read', async () => {
    const configDir = await scratch();
    const projects = join(configDir, 'projects');
    await mkdir(projects, { recursive: true });
    await chmod(projects, 0o000);
    try {
      const listed = await claudeCodeTranscriptFolder({ configDir }).list();

      // A folder nobody can read is not "no transcripts": reporting it as that
      // would be the silent failure of NFR-2, and doctor turns this sentence
      // into a `warn`.
      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(listed.message).toContain(projects);
    } finally {
      await chmod(projects, 0o700);
    }
  });

  it('names the one project folder nobody may read, rather than leaving it out', async () => {
    // Leaving it out quietly would make those transcripts invisible to the
    // scan *and* to doctor's uncollected count, which is the silent loss of
    // NFR-2. So the whole listing says so, and doctor turns it into a `warn`.
    const configDir = await scratch();
    await transcript(configDir, '-demo-a', 'session-a');
    const closed = join(configDir, 'projects', '-demo-closed');
    await mkdir(closed, { recursive: true });
    await writeFile(join(closed, 'session-closed.jsonl'), '{}\n', 'utf8');
    await chmod(closed, 0o000);
    try {
      const listed = await claudeCodeTranscriptFolder({ configDir }).list();

      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(listed.message).toContain(closed);
    } finally {
      await chmod(closed, 0o700);
    }
  });

  it('reports the instant the filesystem holds, so a scan can order by it', async () => {
    const configDir = await scratch();
    const path = await transcript(configDir, '-demo-a', 'session-a');
    const when = new Date('2026-02-03T04:05:06.000Z');
    await utimes(path, when, when);

    const listed = await claudeCodeTranscriptFolder({ configDir }).list();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files[0]?.modifiedAt.getTime()).toBe(when.getTime());
  });
});
