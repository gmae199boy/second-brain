import { BRAIN_MARKER, type Connector } from '../../ports/connector.js';
import {
  assertEqual,
  assertNonEmptyString,
  assertOk,
  assertTrue,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/**
 * What a connector contract needs besides the connector: only the connector
 * knows where its harness keeps its configuration, so it brings a shim path to
 * register and a way to read back what the harness now holds.
 */
export interface ConnectorSubject {
  connector: Connector;
  /** An absolute shim path to hand `connect`. */
  shimPath: string;
  /** Every entry of the target, as the harness holds them. */
  entries(): Promise<readonly string[]>;
  /** The entries of the target that carry `BRAIN_MARKER`. */
  marked(): Promise<readonly string[]>;
  /** Put an entry of the user's own — no marker — into the target. */
  addForeignEntry(entry: string): Promise<void>;
}

/**
 * The connector contract. The heart of it is idempotence by marker: connecting
 * twice leaves one registration and says so with `changed: false`, and the
 * marker is the only thing that decides what is already there (AD-19). Every
 * subject the factory makes is a harness nothing has connected to yet.
 */
export function connectorContract(): ContractCase<ConnectorSubject>[] {
  return [
    contractCase<ConnectorSubject>('the connector names its harness and its parser', async (make) => {
      await withSubject(make, async ({ connector }) => {
        assertNonEmptyString(connector.harness, 'a connector must name its harness');
        assertNonEmptyString(connector.label, 'a connector must carry a label to show');
        assertEqual(
          connector.harness,
          connector.parser.harness,
          'a connector and its parser must name the same harness (AD-8)',
        );
      });
    }),

    contractCase<ConnectorSubject>('detect answers with a value and writes nothing', async (make) => {
      await withSubject(make, async ({ connector, entries, addForeignEntry }) => {
        // Against a target that already holds something, so "wrote nothing"
        // means the file is as it was and not merely that it is empty.
        await addForeignEntry('the user put this here');
        const before = [...(await entries())];

        const found = await connector.detect();

        assertTrue(
          found === true || found === false,
          `detect must answer true or false, got ${String(found)}`,
        );
        assertEqual([...(await entries())], before, 'detect must not write anything');
      });
    }),

    contractCase<ConnectorSubject>('connect records one marked entry and names the target', async (make) => {
      await withSubject(make, async ({ connector, shimPath, marked }) => {
        const result = await connector.connect({ shimPath });
        assertOk(result, 'connect refused a harness the contract set up for it');
        assertNonEmptyString(result.target, 'connect must say which file it wrote');
        assertEqual(result.changed, true, 'the first connect must report a change');
        const registered = await marked();
        assertEqual(
          registered.length,
          1,
          `connect must leave exactly one entry carrying ${BRAIN_MARKER}, found ${String(registered.length)}`,
        );
      });
    }),

    contractCase<ConnectorSubject>('connecting twice changes nothing the second time', async (make) => {
      await withSubject(make, async ({ connector, shimPath, entries, marked }) => {
        const first = await connector.connect({ shimPath });
        assertOk(first, 'the first connect failed');
        const after = [...(await entries())];

        const second = await connector.connect({ shimPath });
        assertOk(second, 'the second connect failed');
        assertEqual(second.changed, false, 'the second connect must report no change (AD-19)');
        assertEqual(second.target, first.target, 'the two connects named two targets');
        assertEqual(
          (await marked()).length,
          1,
          'connecting twice must leave one registration, not two',
        );
        assertEqual([...(await entries())], after, 'the second connect changed the target anyway');
      });
    }),

    contractCase<ConnectorSubject>(
      'entries without the marker are left exactly as they were',
      async (make) => {
        await withSubject(make, async ({ connector, shimPath, entries, addForeignEntry }) => {
          // Everything in a harness's configuration that Brain did not write is
          // the user's, and connecting must not edit, move or drop any of it
          // (AD-19) — not on the first connect, and not on the one that finds
          // its own entry already there.
          const foreign = ['the user put this here', 'and this'];
          for (const entry of foreign) await addForeignEntry(entry);

          await connector.connect({ shimPath });
          await connector.connect({ shimPath });

          const left = [...(await entries())].filter((entry) => !entry.includes(BRAIN_MARKER));
          assertEqual(left, foreign, 'connect changed entries it did not write');
        });
      },
    ),
  ];
}
