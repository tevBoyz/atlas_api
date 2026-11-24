import { DomainError } from '../../common/errors';
import {
  charLength,
  emergencyInfoFromBody,
  isCalendarDate,
  isOwnAvatarPath,
  locationSharingFromBody,
  personalInfoFromBody,
  preferencesFromBody,
  sharingFlagsFromBody,
} from './profile-input';
import { SHARE_FLAGS } from './profile.schemas';

const UID = '4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d';
const TODAY = '2026-11-20';

/** The code and field of the error `fn` throws. */
function failure(fn: () => unknown): { code: string; field: unknown } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const e = error as DomainError;
    return { code: e.code, field: e.details.field };
  }
  throw new Error('expected a failure');
}

const emergency = (overrides: Record<string, unknown> = {}) => ({
  emergency_contact_full_name: 'Musa',
  emergency_contact_relationship: 'friend',
  emergency_contact_phone: '+2203000001',
  location_sharing_enabled: true,
  ...Object.fromEntries(SHARE_FLAGS.map((f) => [f, false])),
  ...overrides,
});

const preferences = (overrides: Record<string, unknown> = {}) => ({
  alert_push_enabled: true,
  alert_email_enabled: true,
  alert_sms_enabled: true,
  location_sharing_enabled: false,
  hide_profile_from_non_members: false,
  app_language: 'en',
  timezone: 'Africa/Banjul',
  preferred_language: 'mnk',
  ...overrides,
});

describe('profile request parsing (API-100-35)', () => {
  describe('helpers', () => {
    it('isCalendarDate accepts real YYYY-MM-DD dates only', () => {
      for (const ok of ['1990-01-15', '2024-02-29', '0001-01-01', '9999-12-31']) {
        expect(isCalendarDate(ok)).toBe(true);
      }
      for (const bad of ['2023-02-29', '1990-13-01', '1990-00-10', '1990-1-5', '0000-01-01', 'x']) {
        expect(isCalendarDate(bad)).toBe(false);
      }
    });

    it('charLength counts characters as Postgres char_length (not UTF-16 units)', () => {
      expect(charLength('😀'.repeat(500))).toBe(500);
      expect('😀'.repeat(500).length).toBe(1000);
    });

    it("isOwnAvatarPath: the caller's lowercase id as the first folder and plain names", () => {
      expect(isOwnAvatarPath(`${UID}/avatar.jpg`, UID)).toBe(true);
      expect(isOwnAvatarPath(`${UID}/avatar-0d4c.png`, UID.toUpperCase())).toBe(true);
      for (const bad of [
        UID,
        `${UID}/`,
        `${UID.toUpperCase()}/avatar.jpg`,
        `x${UID}/avatar.jpg`,
        `other/${UID}/avatar.jpg`,
        `${UID}/../x/avatar.jpg`,
        `${UID}//avatar.jpg`,
        `${UID}/a b.jpg`,
        `https://example.test/${UID}/avatar.jpg`,
        `/${UID}/avatar.jpg`,
      ]) {
        expect({ bad, ok: isOwnAvatarPath(bad, UID) }).toEqual({ bad, ok: false });
      }
    });
  });

  describe('personal info (P2)', () => {
    const parse = (body: unknown) => personalInfoFromBody(body, UID, TODAY);

    it('trims the name; left-out gender and avatar_path keep the stored values', () => {
      expect(parse({ full_name: '  Awa \n', date_of_birth: '1990-01-15' })).toEqual({
        fullName: 'Awa',
        dateOfBirth: '1990-01-15',
        gender: undefined,
        avatarPath: undefined,
      });
      expect(
        parse({ full_name: 'A', date_of_birth: TODAY, gender: null, avatar_path: null }),
      ).toMatchObject({ gender: null, avatarPath: null });
    });

    it('checks in field order: full_name, date_of_birth, gender, avatar_path', () => {
      const all = { full_name: ' ', date_of_birth: '2999-01-01', gender: 'x', avatar_path: 'y' };
      expect(failure(() => parse(all))).toEqual({
        code: 'profiles:invalid_full_name',
        field: 'full_name',
      });
      expect(failure(() => parse({ ...all, full_name: 'A' }))).toEqual({
        code: 'profiles:invalid_date_of_birth',
        field: 'date_of_birth',
      });
      expect(failure(() => parse({ ...all, full_name: 'A', date_of_birth: TODAY }))).toEqual({
        code: 'profiles:invalid_gender',
        field: 'gender',
      });
      expect(
        failure(() => parse({ ...all, full_name: 'A', date_of_birth: TODAY, gender: 'male' })),
      ).toEqual({ code: 'profiles:invalid_avatar_path', field: 'avatar_path' });
    });

    it('missing name or date → the field code; wrong JSON type → validation', () => {
      expect(failure(() => parse({ date_of_birth: TODAY })).code).toBe(
        'profiles:invalid_full_name',
      );
      expect(failure(() => parse({ full_name: 'A' })).code).toBe('profiles:invalid_date_of_birth');
      expect(failure(() => parse({ full_name: 'A', date_of_birth: '2026-11-21' })).code).toBe(
        'profiles:invalid_date_of_birth',
      );
      expect(failure(() => parse({ full_name: 1, date_of_birth: TODAY }))).toEqual({
        code: 'validation:invalid_request',
        field: 'full_name',
      });
      expect(failure(() => parse({ full_name: 'A\u0000', date_of_birth: TODAY })).code).toBe(
        'validation:invalid_request',
      );
      expect(failure(() => parse([]))).toEqual({
        code: 'validation:invalid_request',
        field: 'body',
      });
    });
  });

  describe('emergency info (P3)', () => {
    it('trims, stores blank optional text as null, keeps the flags', () => {
      const values = emergencyInfoFromBody(
        emergency({
          emergency_contact_full_name: ' Musa ',
          emergency_contact_phone: ' +2203000001 ',
          emergency_contact_email: '  ',
          blood_type: '',
          allergies: ' Dust ',
          medical_conditions: null,
          emergency_notes: ' ',
          share_blood_type: true,
        }),
      );
      expect(values).toMatchObject({
        emergency_contact_full_name: 'Musa',
        emergency_contact_phone: '+2203000001',
        emergency_contact_email: null,
        blood_type: null,
        emergency_preferred_language: null,
        emergency_notes: null,
        share_blood_type: true,
        location_sharing_enabled: true,
      });
      expect(Object.keys(values)).not.toContain('emergency_info_completed_at');
      // SCRUM-21 (D51): the item lists own these columns; the PUT ignores them.
      expect(Object.keys(values)).not.toContain('allergies');
      expect(Object.keys(values)).not.toContain('medical_conditions');
    });

    it('checks in field order, each with its own code', () => {
      const cases: [Record<string, unknown>, string, string][] = [
        [
          { emergency_contact_full_name: ' ' },
          'profiles:invalid_emergency_contact_full_name',
          'emergency_contact_full_name',
        ],
        [
          { emergency_contact_relationship: 'boss' },
          'profiles:invalid_relationship',
          'emergency_contact_relationship',
        ],
        [
          { emergency_contact_relationship: undefined },
          'profiles:invalid_relationship',
          'emergency_contact_relationship',
        ],
        [
          { emergency_contact_phone: '2203000001' },
          'profiles:invalid_phone',
          'emergency_contact_phone',
        ],
        [
          { emergency_contact_phone: '+1234567' },
          'profiles:invalid_phone',
          'emergency_contact_phone',
        ],
        [
          { emergency_contact_phone: '+0203000001' },
          'profiles:invalid_phone',
          'emergency_contact_phone',
        ],
        [{ emergency_contact_email: 'no-at' }, 'profiles:invalid_email', 'emergency_contact_email'],
        [{ blood_type: 'C+' }, 'profiles:invalid_blood_type', 'blood_type'],
        [
          { location_sharing_enabled: 'true' },
          'validation:invalid_request',
          'location_sharing_enabled',
        ],
        [
          { emergency_notes: 'x'.repeat(501) },
          'profiles:emergency_notes_too_long',
          'emergency_notes',
        ],
        [{ share_allergies: undefined }, 'validation:invalid_request', 'share_allergies'],
      ];
      for (const [overrides, code, field] of cases) {
        expect({
          overrides,
          ...failure(() => emergencyInfoFromBody(emergency(overrides))),
        }).toEqual({
          overrides,
          code,
          field,
        });
      }
      // The first failing field wins.
      expect(
        failure(() =>
          emergencyInfoFromBody(
            emergency({
              emergency_contact_phone: 'x',
              blood_type: 'C+',
              emergency_notes: 'y'.repeat(600),
            }),
          ),
        ).code,
      ).toBe('profiles:invalid_phone');
    });

    it('notes: 500 characters pass (also 500 emoji), 501 do not', () => {
      expect(
        emergencyInfoFromBody(emergency({ emergency_notes: 'n'.repeat(500) })).emergency_notes,
      ).toHaveLength(500);
      expect(
        emergencyInfoFromBody(emergency({ emergency_notes: '😀'.repeat(500) })).emergency_notes,
      ).toBe('😀'.repeat(500));
    });
  });

  describe('share_phone in emergency info (SCRUM-52, D59)', () => {
    it('is optional: left out keeps the stored value (not in the values written)', () => {
      expect(emergencyInfoFromBody(emergency())).not.toHaveProperty('share_phone');
    });

    it('when sent it must be a JSON boolean, checked after the 9 flags', () => {
      expect(emergencyInfoFromBody(emergency({ share_phone: false })).share_phone).toBe(false);
      expect(emergencyInfoFromBody(emergency({ share_phone: true })).share_phone).toBe(true);
      expect(failure(() => emergencyInfoFromBody(emergency({ share_phone: 'yes' })))).toEqual({
        code: 'validation:invalid_request',
        field: 'share_phone',
      });
      expect(failure(() => emergencyInfoFromBody(emergency({ share_phone: null })))).toEqual({
        code: 'validation:invalid_request',
        field: 'share_phone',
      });
    });
  });

  describe('preferences (P4)', () => {
    it('accepts the fixed language and time zone and the 4 preferred languages', () => {
      for (const lang of ['en', 'wo', 'mnk', 'ff']) {
        expect(
          preferencesFromBody(preferences({ preferred_language: lang })).preferred_language,
        ).toBe(lang);
      }
    });

    it('checks the booleans, then app_language, timezone, preferred_language', () => {
      expect(failure(() => preferencesFromBody(preferences({ alert_sms_enabled: 1 })))).toEqual({
        code: 'validation:invalid_request',
        field: 'alert_sms_enabled',
      });
      expect(failure(() => preferencesFromBody(preferences({ app_language: 'fr' }))).code).toBe(
        'profiles:invalid_app_language',
      );
      expect(
        failure(() => preferencesFromBody(preferences({ app_language: undefined }))).code,
      ).toBe('profiles:invalid_app_language');
      expect(failure(() => preferencesFromBody(preferences({ timezone: 'UTC' }))).code).toBe(
        'profiles:invalid_timezone',
      );
      expect(
        failure(() => preferencesFromBody(preferences({ preferred_language: 'EN' }))).code,
      ).toBe('profiles:invalid_preferred_language');
    });
  });

  describe('sharing flags (P5) and location sharing (P6)', () => {
    it('keeps only the 9 flags that were sent; ignores other keys', () => {
      expect(
        sharingFlagsFromBody({
          share_allergies: true,
          emergency_notes_shareable: false,
          allergies: 'x',
        }),
      ).toEqual({ share_allergies: true, emergency_notes_shareable: false });
      expect(sharingFlagsFromBody({})).toEqual({});
    });

    it('accepts share_phone (SCRUM-52, D59) alone or with the 9 flags', () => {
      expect(sharingFlagsFromBody({ share_phone: false })).toEqual({ share_phone: false });
      expect(sharingFlagsFromBody({ share_phone: true, share_blood_type: false })).toEqual({
        share_phone: true,
        share_blood_type: false,
      });
      expect(failure(() => sharingFlagsFromBody({ share_phone: 1 }))).toEqual({
        code: 'validation:invalid_request',
        field: 'share_phone',
      });
    });

    it('a flag that is not a JSON boolean → validation on that flag', () => {
      expect(failure(() => sharingFlagsFromBody({ share_blood_type: null }))).toEqual({
        code: 'validation:invalid_request',
        field: 'share_blood_type',
      });
    });

    it('location sharing needs {enabled: boolean}', () => {
      expect(locationSharingFromBody({ enabled: false })).toBe(false);
      expect(failure(() => locationSharingFromBody({ enabled: 'on' }))).toEqual({
        code: 'validation:invalid_request',
        field: 'enabled',
      });
    });
  });
});
