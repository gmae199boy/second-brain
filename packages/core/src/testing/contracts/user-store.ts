import type { UserStore } from '../../ports/store.js';
import {
  assertEqual,
  assertNonEmptyString,
  assertOk,
  assertTrue,
  assertValidDate,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { otherUserId, sampleSelfUserInput, sampleUserId } from '../fixtures.js';

/**
 * The identity capability: who this brain belongs to (AD-12).
 *
 * The whole of it is "decided once". The owner is created by the install that
 * made the database and never again — not by a second install, not by a
 * re-configuration, and not by the database being copied to another machine,
 * where the operating system user has a different name. A store that let the
 * second call through would give the same person two ids, and every session
 * ingested after that would point at whichever one happened to be read.
 */
export function userStoreContract(): ContractCase<UserStore>[] {
  return [
    contractCase<UserStore>('readSelfUser answers null before there is an owner', async (make) => {
      await withSubject(make, async (store) => {
        const read = await store.readSelfUser();
        assertOk(read, 'readSelfUser must answer with a value, even with no row');
        assertEqual(
          read.user,
          null,
          'a database with no owner row must answer null rather than fail',
        );
      });
    }),

    contractCase<UserStore>('ensureSelfUser creates the owner and reads back', async (make) => {
      await withSubject(make, async (store) => {
        const input = sampleSelfUserInput();
        const created = await store.ensureSelfUser(input);
        assertOk(created, 'the first ensureSelfUser failed');
        assertTrue(created.created, 'the first ensureSelfUser must create the row');
        assertEqual(created.user.id, input.id, 'the created owner kept another id');
        assertEqual(created.user.name, input.name, 'the created owner kept another name');
        assertTrue(created.user.isSelf, 'the owner row must be the self row');
        assertEqual(
          created.user.createdAt,
          input.createdAt,
          'the owner must keep the instant it was given, not one the store read (AD-13)',
        );

        const read = await store.readSelfUser();
        assertOk(read, 'readSelfUser failed after the owner was created');
        const { user } = read;
        if (user === null) {
          assertTrue(false, 'the owner that was just created could not be read back');
          return;
        }
        assertEqual(user, created.user, 'readSelfUser answered something else than ensure did');
        assertNonEmptyString(user.id, 'an owner must carry an id');
        assertNonEmptyString(user.name, 'an owner must carry a name');
        assertValidDate(user.createdAt, 'an owner must say when it was created');
      });
    }),

    contractCase<UserStore>(
      'a second ensureSelfUser keeps the first row, whatever it proposes',
      async (make) => {
        await withSubject(make, async (store) => {
          const first = await store.ensureSelfUser(sampleSelfUserInput());
          assertOk(first, 'the first ensureSelfUser failed');

          const again = await store.ensureSelfUser(
            sampleSelfUserInput({
              id: otherUserId,
              name: 'somebody-else',
              createdAt: new Date('2027-06-07T08:09:10.000Z'),
            }),
          );
          assertOk(again, 'the second ensureSelfUser failed');
          assertTrue(
            !again.created,
            'the second ensureSelfUser must not create a second owner (AD-12)',
          );
          assertEqual(
            again.user.id,
            sampleUserId,
            'ensureSelfUser must hand back the existing owner, not the proposed id',
          );
          assertEqual(
            again.user.name,
            first.user.name,
            'the owner name is never updated here: that is epic 5 (Boundaries)',
          );

          const read = await store.readSelfUser();
          assertOk(read, 'readSelfUser failed after the second ensureSelfUser');
          assertEqual(
            read.user,
            first.user,
            'the store holds more than one owner, or replaced the first one',
          );
        });
      },
    ),
  ];
}
