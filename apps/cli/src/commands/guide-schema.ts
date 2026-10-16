import type { CommandSpec, StandaloneCommandContext } from '../dispatch.js';
import { argumentName } from '../envelope.js';

/**
 * `brain guide schema [ns] [verb]`: what every command of this build is for,
 * what it takes, what it gives back, and how much it can cost.
 *
 * It is built from the registry rather than from a written document, which is
 * the whole point of the meta being mandatory: a command that exists is a
 * command this answers for, and a command described here is one you can
 * actually run. The seven fields are rendered in the envelope's own spelling —
 * `used_for`, `dry_run` — because this is read by whatever reads envelopes
 * (Conventions, 이름).
 *
 * `standalone`, with `risk: read` and `hook: false`: it reads no configuration
 * and opens no database, so it answers on a machine where nothing is installed
 * yet. The plugin's install step calls `guide schema --json` as its proof that
 * the build works (epic 2, story 5), and a check that needed a working install
 * to pass would be no check at all.
 */

/** One command's meta, its arguments and its flags, as the schema carries it. */
export interface CommandSchema {
  ns: string;
  verb: string;
  used_for: string;
  required: readonly string[];
  examples: readonly string[];
  output: string;
  risk: string;
  hook: boolean;
  dry_run: boolean;
  arguments: readonly { name: string; required: boolean }[];
  options: readonly { flags: string; description: string }[];
}

export interface GuideSchemaData {
  /** Every command asked for, in the registry's order — which is `--help`'s. */
  commands: readonly CommandSchema[];
}

/**
 * Built from the registry it describes, not from the one import of it: the
 * registry holds this command, so importing it here would be a cycle, and a
 * test wants to hand it a registry of its own anyway.
 */
export function guideSchemaCommand(
  registry: () => readonly CommandSpec[],
): CommandSpec<GuideSchemaData> {
  return {
    ns: 'guide',
    verb: 'schema',
    nsDescription: '이 CLI를 어떻게 쓰는지 알려 줍니다',
    usedFor: '등록된 명령과 그 메타를 냅니다. 좁히려면 ns와 verb를 주세요',
    required: [],
    examples: [
      'brain guide schema --json',
      'brain guide schema doctor',
      'brain guide schema doctor run',
    ],
    output: '명령마다 메타 일곱 칸과 인자·옵션이 든 `commands`',
    risk: 'read',
    hook: false,
    dryRun: false,
    standalone: true,
    arguments: ['[ns]', '[verb]'],

    async run(context: StandaloneCommandContext) {
      const commands = registry();
      const [ns, verb] = context.args;

      if (ns !== undefined) {
        const inNamespace = commands.filter((spec) => spec.ns === ns);
        if (inNamespace.length === 0) {
          return {
            ok: false as const,
            code: 'USAGE',
            message: `"${ns}"라는 이름공간이 없습니다. ${knownNamespaces(commands)}`,
            exit: 2 as const,
          };
        }
        if (verb !== undefined) {
          const one = inNamespace.find((spec) => spec.verb === verb);
          if (one === undefined) {
            return {
              ok: false as const,
              code: 'USAGE',
              message: `"${ns}"에 "${verb}"라는 동사가 없습니다. ${knownVerbs(inNamespace)}`,
              exit: 2 as const,
            };
          }
          return answer([one]);
        }
        return answer(inNamespace);
      }

      return answer(commands);
    },
  };
}

/** The same answer for one command, one namespace or all of them. */
function answer(commands: readonly CommandSpec[]): {
  ok: true;
  data: GuideSchemaData;
  text: readonly string[];
} {
  const schemas = commands.map(schemaOf);
  return { ok: true, data: { commands: schemas }, text: schemas.flatMap(lines) };
}

function schemaOf(spec: CommandSpec): CommandSchema {
  return {
    ns: spec.ns,
    verb: spec.verb,
    used_for: spec.usedFor,
    required: [...spec.required],
    examples: [...spec.examples],
    output: spec.output,
    risk: spec.risk,
    hook: spec.hook,
    dry_run: spec.dryRun,
    arguments: (spec.arguments ?? []).map((declared) => ({
      name: argumentName(declared),
      // Commander's own syntax: `<name>` has to be given, `[name]` need not.
      required: declared.startsWith('<'),
    })),
    options: (spec.options ?? []).map((option) => ({
      flags: option.flags,
      description: option.description,
    })),
  };
}

/**
 * One command as a few lines, for the person at the terminal. The envelope is
 * for whatever reads envelopes; this is the same facts in the order somebody
 * reading down the screen wants them — what it is, how to type it, what comes
 * back, what it costs.
 */
function lines(schema: CommandSchema): readonly string[] {
  const out = [`${schema.ns} ${schema.verb}: ${schema.used_for}`];
  if (schema.required.length > 0) {
    out.push(`  반드시 줄 것: ${schema.required.map((name) => `\`${name}\``).join(', ')}`);
  }
  for (const argument of schema.arguments) {
    // Which of the two it is matters more than the name: an optional argument
    // left out is a different call, not a broken one.
    out.push(`  인자: \`${argument.name}\` (${argument.required ? '필수' : '생략 가능'})`);
  }
  for (const option of schema.options) {
    out.push(`  옵션: \`${option.flags}\` — ${option.description}`);
  }
  for (const example of schema.examples) out.push(`  예시: ${example}`);
  out.push(`  출력: ${schema.output}`);
  out.push(
    `  위험도: \`${schema.risk}\` · hook 경로: ${schema.hook ? '예' : '아니요'}` +
      ` · \`--dry-run\`: ${schema.dry_run ? '있습니다' : '없습니다'}`,
  );
  return out;
}

/** The namespaces this build registers, for the `USAGE` message. */
function knownNamespaces(commands: readonly CommandSpec[]): string {
  const names = [...new Set(commands.map((spec) => spec.ns))];
  return `아는 이름공간: ${names.join(', ')}.`;
}

/**
 * The verbs of one namespace, for the `USAGE` message. The namespace is not
 * named again: the sentence in front of this one already did, and a Korean
 * particle after an English word is a guess about how that word is pronounced.
 */
function knownVerbs(inNamespace: readonly CommandSpec[]): string {
  return `아는 동사: ${inNamespace.map((spec) => spec.verb).join(', ')}.`;
}
