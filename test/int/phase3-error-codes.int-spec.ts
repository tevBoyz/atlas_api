import { randomUUID } from 'node:crypto';
import { AvatarNames } from '../../src/modules/profiles/avatar-names';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { httpStatusForCode, PARITY_ERROR_CODES } from '../../src/common/errors';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { errorOf } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { goneUser } from '../support/test-sessions';
import { createUser, fakePhone } from '../support/fixtures';
import { insertMember } from '../support/invite-rows';
import {
  addMedicalItem,
  completeSetup,
  createAuthUser,
  createAvatarUploadUrl,
  deleteMedicalItem,
  editMedicalItem,
  emergencyInfoBody,
  getProfile,
  personalInfoBody,
  preferencesBody,
  putEmergencyInfo,
  putPersonalInfo,
  putPreferences,
  setAvatar,
} from '../support/profile-api';
import { specProfileErrorCodes } from '../support/spec-error-codes';

/**
 * API-100-38: every `profiles:*` and `complete_profile_setup:*` error code of the specification is
 * produced by a real response. The codes are read from `docs/api_doc.md` (§7.1 and the §11.3 rows
 * P1-P9), not typed here, and must be exactly the parity catalogue of the two prefixes. Each producer
 * sends one request (fresh fixtures) and checks the envelope's code and its HTTP status (spec §11.2,
 * and the statuses the Phase 3 codes were given: 422 for request values, 404 for a missing row or
 * object, 503 for Storage).
 *
 * One code cannot occur, in the SQL function or in the API, and is proved unreachable instead:
 * `complete_profile_setup:circle_full`. The function catches the capacity trigger's `circle_full`
 * on the contact row since 2026-11-17 (setup succeeds and the row is left as it is), and so does the
 * API; the owner row never needs a slot.
 */
type Reply = Awaited<ReturnType<typeof getProfile>>;

const PREFIXES = ['profiles', 'complete_profile_setup'] as const;

const UNREACHABLE: Record<string, string> = {
  'complete_profile_setup:circle_full':
    'the contact row refresh at 5/5 is caught (setup succeeds, row left as it is); the owner row holds no slot',
};

/** The HTTP status each Phase 3 code must have. */
const EXPECTED_STATUS: Record<string, number> = {
  'profiles:not_authenticated': 401,
  'profiles:profile_not_found': 404,
  'profiles:avatar_not_found': 404,
  'profiles:avatar_storage_unavailable': 503,
  // SCRUM-21 (D51).
  'profiles:duplicate_medical_item': 409,
  'profiles:medical_item_limit_reached': 409,
  'profiles:medical_item_not_found': 404,
  'complete_profile_setup:not_authenticated': 401,
  'complete_profile_setup:profile_not_found': 404,
  'complete_profile_setup:personal_info_incomplete': 409,
  'complete_profile_setup:emergency_info_incomplete': 409,
  'complete_profile_setup:preferences_incomplete': 409,
  'complete_profile_setup:circle_full': 409,
};

describe('Phase 3 gate: every profile error code of the spec is produced (API-100-38)', () => {
  let app: NestFastifyApplication;
  let bare: NestFastifyApplication;
  let client: Client;
  const seen = new Map<string, number>();
  const specCodes = specProfileErrorCodes();
  const catalogue = PREFIXES.flatMap((prefix) =>
    (PARITY_ERROR_CODES[prefix] as readonly string[]).map((suffix) => `${prefix}:${suffix}`),
  );

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ AVATAR_STORAGE: 'memory', RATE_LIMIT_AUTHENTICATED_MAX: '1000000' }),
    ));
    // Storage not configured: the deployment default without SUPABASE_STORAGE_SERVICE_KEY.
    ({ app: bare } = await createTestApp({}, withTestConfig({ AVATAR_STORAGE: 'supabase' })));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
    await bare?.close();
  });

  const record = (reply: Reply, code: string) => {
    const status = EXPECTED_STATUS[code] ?? 422;
    expect({ code, status: reply.statusCode, got: errorOf(reply).code }).toEqual({
      code,
      status,
      got: code,
    });
    expect(httpStatusForCode(code)).toBe(status);
    seen.set(code, reply.statusCode);
  };

  const newAuthUser = async () => {
    const id = randomUUID();
    await createAuthUser(client, id);
    return id;
  };

  const readyForSetup = async () => {
    const user = await createUser(client);
    await client.query(
      `update public.profiles set profile_setup_completed_at = null, emergency_contact_phone = $2
        where id = $1`,
      [user.id, fakePhone()],
    );
    return user;
  };

  const producers: Record<string, () => Promise<void>> = {
    'profiles:not_authenticated': async () => {
      record(await getProfile(app, null), 'profiles:not_authenticated');
      // Also a token whose user no longer exists (its session went with the account).
      record(
        await putPersonalInfo(app, await goneUser(client), personalInfoBody()),
        'profiles:not_authenticated',
      );
    },
    'profiles:profile_not_found': async () =>
      record(await getProfile(app, await newAuthUser()), 'profiles:profile_not_found'),
    'profiles:invalid_full_name': async () =>
      record(
        await putPersonalInfo(app, await newAuthUser(), personalInfoBody({ full_name: ' ' })),
        'profiles:invalid_full_name',
      ),
    'profiles:invalid_date_of_birth': async () =>
      record(
        await putPersonalInfo(
          app,
          await newAuthUser(),
          personalInfoBody({ date_of_birth: '2999-01-01' }),
        ),
        'profiles:invalid_date_of_birth',
      ),
    'profiles:invalid_gender': async () =>
      record(
        await putPersonalInfo(app, await newAuthUser(), personalInfoBody({ gender: 'unknown' })),
        'profiles:invalid_gender',
      ),
    'profiles:invalid_avatar_path': async () => {
      const id = await newAuthUser();
      record(
        await putPersonalInfo(app, id, personalInfoBody({ avatar_path: `${randomUUID()}/a.jpg` })),
        'profiles:invalid_avatar_path',
      );
      const user = await createUser(client);
      record(
        await setAvatar(app, user.id, { object_path: `${randomUUID()}/a.jpg` }),
        'profiles:invalid_avatar_path',
      );
    },
    'profiles:invalid_emergency_contact_full_name': async () =>
      record(
        await putEmergencyInfo(
          app,
          (await createUser(client)).id,
          emergencyInfoBody({ emergency_contact_full_name: '' }),
        ),
        'profiles:invalid_emergency_contact_full_name',
      ),
    'profiles:invalid_relationship': async () =>
      record(
        await putEmergencyInfo(
          app,
          (await createUser(client)).id,
          emergencyInfoBody({ emergency_contact_relationship: 'neighbour' }),
        ),
        'profiles:invalid_relationship',
      ),
    'profiles:invalid_phone': async () =>
      record(
        await putEmergencyInfo(
          app,
          (await createUser(client)).id,
          emergencyInfoBody({ emergency_contact_phone: '3000001' }),
        ),
        'profiles:invalid_phone',
      ),
    'profiles:invalid_email': async () =>
      record(
        await putEmergencyInfo(
          app,
          (await createUser(client)).id,
          emergencyInfoBody({ emergency_contact_email: 'nobody' }),
        ),
        'profiles:invalid_email',
      ),
    'profiles:invalid_blood_type': async () =>
      record(
        await putEmergencyInfo(
          app,
          (await createUser(client)).id,
          emergencyInfoBody({ blood_type: 'Z' }),
        ),
        'profiles:invalid_blood_type',
      ),
    'profiles:emergency_notes_too_long': async () =>
      record(
        await putEmergencyInfo(
          app,
          (await createUser(client)).id,
          emergencyInfoBody({ emergency_notes: 'n'.repeat(501) }),
        ),
        'profiles:emergency_notes_too_long',
      ),
    'profiles:invalid_app_language': async () =>
      record(
        await putPreferences(
          app,
          (await createUser(client)).id,
          preferencesBody({ app_language: 'wo' }),
        ),
        'profiles:invalid_app_language',
      ),
    'profiles:invalid_timezone': async () =>
      record(
        await putPreferences(
          app,
          (await createUser(client)).id,
          preferencesBody({ timezone: 'UTC' }),
        ),
        'profiles:invalid_timezone',
      ),
    'profiles:invalid_preferred_language': async () =>
      record(
        await putPreferences(
          app,
          (await createUser(client)).id,
          preferencesBody({ preferred_language: 'fr' }),
        ),
        'profiles:invalid_preferred_language',
      ),
    'profiles:invalid_content_type': async () =>
      record(
        await createAvatarUploadUrl(app, (await createUser(client)).id, {
          content_type: 'image/gif',
          content_length: 10,
        }),
        'profiles:invalid_content_type',
      ),
    'profiles:file_too_large': async () =>
      record(
        await createAvatarUploadUrl(app, (await createUser(client)).id, {
          content_type: 'image/jpeg',
          content_length: 5_242_881,
        }),
        'profiles:file_too_large',
      ),
    'profiles:avatar_not_found': async () => {
      const user = await createUser(client);
      record(
        await setAvatar(app, user.id, {
          object_path: app.get(AvatarNames).newPath(user.id, 'jpg'),
        }),
        'profiles:avatar_not_found',
      );
    },
    'profiles:avatar_storage_unavailable': async () => {
      const user = await createUser(client);
      record(
        await createAvatarUploadUrl(bare, user.id, {
          content_type: 'image/png',
          content_length: 1,
        }),
        'profiles:avatar_storage_unavailable',
      );
    },
    'profiles:invalid_medical_item': async () =>
      record(
        await addMedicalItem(app, (await createUser(client)).id, 'allergies', { text: ' ' }),
        'profiles:invalid_medical_item',
      ),
    'profiles:duplicate_medical_item': async () => {
      const user = await createUser(client);
      await addMedicalItem(app, user.id, 'medical-conditions', { text: 'Asthma' });
      record(
        await addMedicalItem(app, user.id, 'medical-conditions', { text: 'ASTHMA' }),
        'profiles:duplicate_medical_item',
      );
    },
    'profiles:medical_item_limit_reached': async () => {
      const user = await createUser(client);
      for (let i = 0; i < 20; i += 1) {
        await addMedicalItem(app, user.id, 'allergies', { text: `Item ${i}` });
      }
      record(
        await addMedicalItem(app, user.id, 'allergies', { text: 'Item 20' }),
        'profiles:medical_item_limit_reached',
      );
    },
    'profiles:medical_item_not_found': async () => {
      const user = await createUser(client);
      record(
        await editMedicalItem(app, user.id, 'allergies', randomUUID(), { text: 'x' }),
        'profiles:medical_item_not_found',
      );
      record(
        await deleteMedicalItem(app, user.id, 'medical-conditions', randomUUID()),
        'profiles:medical_item_not_found',
      );
    },
    'complete_profile_setup:not_authenticated': async () =>
      record(await completeSetup(app, null), 'complete_profile_setup:not_authenticated'),
    'complete_profile_setup:profile_not_found': async () =>
      record(
        await completeSetup(app, await newAuthUser()),
        'complete_profile_setup:profile_not_found',
      ),
    'complete_profile_setup:personal_info_incomplete': async () => {
      const user = await readyForSetup();
      await client.query(
        'update public.profiles set personal_info_completed_at = null where id = $1',
        [user.id],
      );
      record(await completeSetup(app, user.id), 'complete_profile_setup:personal_info_incomplete');
    },
    'complete_profile_setup:emergency_info_incomplete': async () => {
      const user = await readyForSetup();
      await client.query(
        `update public.profiles set emergency_contact_phone = '+1234567' where id = $1`,
        [user.id],
      );
      record(await completeSetup(app, user.id), 'complete_profile_setup:emergency_info_incomplete');
    },
    'complete_profile_setup:preferences_incomplete': async () => {
      const user = await readyForSetup();
      await client.query(
        'update public.profiles set preferences_completed_at = null where id = $1',
        [user.id],
      );
      record(await completeSetup(app, user.id), 'complete_profile_setup:preferences_incomplete');
    },
  };

  it('reads the profile codes of spec §7.1 and §11.3 P1-P9', () => {
    expect(new Set(specCodes.map((code) => code.split(':')[0]))).toEqual(new Set(PREFIXES));
  });

  it('the spec codes are exactly the parity catalogue for these prefixes', () => {
    expect([...specCodes].sort()).toEqual([...catalogue].sort());
  });

  it('has a producer for every spec and catalogue code, except the one proved unreachable', () => {
    const covered = new Set([...Object.keys(producers), ...Object.keys(UNREACHABLE)]);
    for (const code of new Set([...specCodes, ...catalogue])) {
      expect({ code, covered: covered.has(code) }).toEqual({ code, covered: true });
    }
  });

  it.each(Object.keys(producers))('produces %s', async (code) => {
    await producers[code]();
  });

  it('complete_profile_setup:circle_full cannot occur: setup at 5/5 succeeds and leaves the contact row', async () => {
    const user = await readyForSetup();
    const { rows } = await client.query<{ phone: string }>(
      'select emergency_contact_phone as phone from public.profiles where id = $1',
      [user.id],
    );
    const first = await completeSetup(app, user.id);
    expect(first.statusCode).toBe(200);
    const circleId = first.json<{ circle_id: string }>().circle_id;
    // The contact declines (as decline leaves the row), then the circle fills up.
    await client.query(
      `update public.safety_circle_members set status = 'declined', invite_canceled_at = now()
        where circle_id = $1 and phone = $2`,
      [circleId, rows[0].phone],
    );
    for (let i = 0; i < 5; i++) await insertMember(client, circleId, { name: `Fill ${i}` });
    const again = await completeSetup(app, user.id);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ member_status: string }>().member_status).toBe('declined');
  });

  it('every spec code was seen in a response (or is proved unreachable)', () => {
    for (const code of new Set([...specCodes, ...catalogue])) {
      if (code in UNREACHABLE) continue;
      expect({ code, seen: seen.has(code) }).toEqual({ code, seen: true });
    }
  });
});
