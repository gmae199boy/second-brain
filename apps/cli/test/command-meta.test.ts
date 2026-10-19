import { describe, expect, it } from 'vitest';
import { commands } from '../src/commands/index.js';
import {
  selectedCommand,
  validateCommandMeta,
  type CommandSpec,
} from '../src/dispatch.js';

/**
 * The seven mandatory meta fields (Conventions, 명령 메타), on the registry this
 * build ships and on specs that break each rule.
 *
 * The type already makes the fields mandatory, so a careless omission is
 * caught by `tsc`. The runtime check exists for the two things a type cannot
 * see: a value that reached the registry from a cast or from data, and the
 * agreements *between* fields — a command that writes is not a `read`, a
 * declared `<argument>` is a required input, and an example has to be a line
 * this very registry would accept.
 */

/** A spec with the seven fields filled in, as a starting point to break. */
function wellFormed(): CommandSpec {
  return {
    ns: 'fake',
    verb: 'read',
    usedFor: '아무것도 하지 않습니다',
    required: [],
    examples: ['brain fake read'],
    output: '아무것도 없습니다',
    risk: 'read',
    hook: false,
    dryRun: false,
    standalone: true,
    run: async () => ({ ok: true as const, data: null }),
  };
}

/** The same spec with one field taken out, the way only a cast can do it. */
function without(field: keyof CommandSpec): CommandSpec {
  const spec = wellFormed() as unknown as Record<string, unknown>;
  delete spec[field];
  return spec as unknown as CommandSpec;
}

describe('the meta of every registered command', () => {
  it.each(commands.map((spec) => [`${spec.ns} ${spec.verb}`, spec] as const))(
    '%s declares all seven fields and agrees with itself',
    (_name, spec) => {
      expect(validateCommandMeta(spec)).toEqual([]);
    },
  );

  it.each(commands.map((spec) => [`${spec.ns} ${spec.verb}`, spec] as const))(
    '%s has examples this registry actually selects',
    (_name, spec) => {
      for (const example of spec.examples) {
        const [binary, ...argv] = example.split(/\s+/);
        // Every example is a whole command line, so it starts with the binary
        // and not with the namespace.
        expect(binary).toBe('brain');

        const chosen = selectedCommand(commands, argv);
        // The point of the assertion: an example that selects nothing, or
        // selects something else, is documentation for a command that is not
        // this one.
        expect(
          chosen === undefined ? 'nothing' : `${chosen.ns} ${chosen.verb}`,
          example,
        ).toBe(`${spec.ns} ${spec.verb}`);
      }
    },
  );

  it('registers no two commands under the same name', () => {
    const names = commands.map((spec) => `${spec.ns} ${spec.verb}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no `admin` namespace left', () => {
    // The namespace is the thing a command is about, never the kind of person
    // who runs it (AD-5, Decision 2026-10-16).
    expect(commands.map((spec) => spec.ns)).not.toContain('admin');
  });
});

describe('the meta check', () => {
  it.each([
    ['usedFor', 'usedFor is missing'],
    ['required', 'required must be a list'],
    ['examples', 'examples is missing'],
    ['output', 'output is missing'],
    ['risk', 'risk must be one of'],
    ['hook', 'hook is missing'],
    ['dryRun', 'dryRun is missing'],
  ] as const)('fails a spec with no %s', (field, said) => {
    const problems = validateCommandMeta(without(field));

    expect(problems).not.toEqual([]);
    expect(problems.join('\n')).toContain(said);
  });

  it('passes the well-formed spec the cases above start from', () => {
    expect(validateCommandMeta(wellFormed())).toEqual([]);
  });

  it.each(['readonly', 'toString'])('refuses the risk value %s, outside the three', (risk) => {
    // `toString` is in here because it is a key of every object's prototype: a
    // check written with `in` rather than `Object.hasOwn` accepts it.
    const spec = { ...wellFormed(), risk } as unknown as CommandSpec;

    expect(validateCommandMeta(spec).join('\n')).toContain('risk must be one of');
  });

  it('refuses a command that writes and calls itself a read', () => {
    const spec: CommandSpec = {
      ...wellFormed(),
      standalone: false,
      writes: true,
      risk: 'read',
      run: async () => ({ ok: true as const, data: null }),
    };

    expect(validateCommandMeta(spec).join('\n')).toContain('risk may not be read');
  });

  it('refuses a spool branch on a command that does not write', () => {
    // The branch is reached from the write guard and from nowhere else, so one
    // declared without `writes` is a branch that can never run (AD-9).
    const spec: CommandSpec = {
      ...wellFormed(),
      standalone: false,
      risk: 'write',
      run: async () => ({ ok: true as const, data: null }),
      spool: async () => ({ ok: true as const, data: null }),
    };

    expect(validateCommandMeta(spec).join('\n')).toContain('must declare writes');
  });

  it('accepts the same command once it says it writes', () => {
    const spec: CommandSpec = {
      ...wellFormed(),
      standalone: false,
      writes: true,
      risk: 'write',
      run: async () => ({ ok: true as const, data: null }),
    };

    expect(validateCommandMeta(spec)).toEqual([]);
  });

  it('refuses a promise of --dry-run that no option keeps', () => {
    const spec: CommandSpec = { ...wellFormed(), dryRun: true };

    expect(validateCommandMeta(spec).join('\n')).toContain('--dry-run option');
  });

  it('accepts dryRun once the flag is declared', () => {
    const spec: CommandSpec = {
      ...wellFormed(),
      dryRun: true,
      options: [{ flags: '--dry-run', description: '무엇을 할지만 말하고 하지 않습니다' }],
    };

    expect(validateCommandMeta(spec)).toEqual([]);
  });

  it('refuses a required argument the required list does not name', () => {
    const spec: CommandSpec = { ...wellFormed(), arguments: ['<harness>'] };

    expect(validateCommandMeta(spec).join('\n')).toContain('does not name the argument <harness>');
  });

  it('asks nothing about an optional argument', () => {
    // `[ns]` need not be given, so it is not an input a caller must supply.
    const spec: CommandSpec = { ...wellFormed(), arguments: ['[ns]', '[verb]'] };

    expect(validateCommandMeta(spec)).toEqual([]);
  });

  it('refuses an example that is not a line of this command', () => {
    const spec: CommandSpec = { ...wellFormed(), examples: ['fake read', 'brain fake write'] };

    const problems = validateCommandMeta(spec).join('\n');
    expect(problems).toContain('fake read');
    expect(problems).toContain('brain fake write');
  });
});
