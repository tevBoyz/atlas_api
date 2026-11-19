import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import type { ApiConfigService } from '../../config';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import {
  batchInvitesFromBody,
  linkInviteFromBody,
  pgTrim,
  phoneInviteFromBody,
  requireMemberId,
} from './invite-input';
import { INVITE_TOKEN_FORMAT, newInviteToken } from './invite-token';
import type { LockedMemberRow, OwnerInvitesRepository } from './owner-invites.repository';
import {
  InviteOperationFailedError,
  isTriggerCircleFull,
  OwnerInvitesService,
} from './owner-invites.service';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  issuer: 'supabase',
  sessionId: null,
  email: null,
  phone: null,
};
const CIRCLE = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const PHONE = '+447700900001';

/** The raw message of `enforce_safety_circle_member_capacity`, as node-postgres raises it. */
function triggerCircleFull(): Error {
  const pg = Object.assign(new Error('circle_full'), { code: 'P0001' });
  return Object.assign(new Error('Failed query: insert ...'), { cause: pg });
}

function payload(resent: boolean) {
  return { member_id: MEMBER, circle_id: CIRCLE, resent, invite_token: 'x', status: 'pending' };
}

function pendingRow(overrides: Partial<LockedMemberRow> = {}): LockedMemberRow {
  return {
    id: MEMBER,
    circle_id: CIRCLE,
    role: 'member',
    status: 'pending',
    display_name: 'Stored',
    relationship: 'friend',
    consumed: false,
    holds_slot: false,
    lookup_status: 'expired',
    ...overrides,
  };
}

function serviceWith(overrides: Partial<Record<keyof OwnerInvitesRepository, jest.Mock>> = {}) {
  const repository = {
    useUtcTimestamps: jest.fn().mockResolvedValue(undefined),
    ownerSharing: jest.fn().mockResolvedValue({ sharing: true }),
    lockOwnedCircle: jest.fn().mockResolvedValue(CIRCLE),
    availableSlots: jest.fn().mockResolvedValue(1),
    lockMemberByPhone: jest.fn().mockResolvedValue(undefined),
    lockMemberInCircle: jest.fn().mockResolvedValue(pendingRow()),
    lockMember: jest.fn(),
    isCircleOwner: jest.fn().mockResolvedValue(true),
    batchItems: jest.fn().mockResolvedValue([]),
    insertPhoneInvite: jest.fn().mockResolvedValue(payload(false)),
    insertLinkInvite: jest.fn().mockResolvedValue(payload(false)),
    refresh: jest.fn().mockResolvedValue(payload(true)),
    cancel: jest.fn(),
    ...overrides,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // A transaction whose savepoints run like the real ones: an error inside rolls back to it.
  const tx = { transaction: (run: (sp: object) => Promise<unknown>) => run(tx) };
  const database = { db: { transaction: (run: (t: object) => Promise<unknown>) => run(tx) } };
  const config = { get: () => 'io.supabase.atlasmobile://invite/' };
  const service = new OwnerInvitesService(
    database as unknown as DatabaseService,
    repository as unknown as OwnerInvitesRepository,
    audit as unknown as AuditService,
    config as unknown as ApiConfigService,
  );
  return { service, repository, audit };
}

/** The DomainError a call throws (undefined when it does not throw). */
function thrown(call: () => unknown): DomainError | undefined {
  try {
    call();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  return undefined;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('OwnerInvitesService: the trigger backstop (API-100-05 AC3)', () => {
  it('maps the raw circle_full of an insert to <operation>:circle_full', async () => {
    const { service, audit } = serviceWith({
      insertPhoneInvite: jest.fn().mockRejectedValue(triggerCircleFull()),
      insertLinkInvite: jest.fn().mockRejectedValue(triggerCircleFull()),
    });
    expect(
      await codeOf(
        service.invitePhone(USER, { displayName: 'A', phone: PHONE, relationship: null }),
      ),
    ).toBe('invite_circle_member_by_phone:circle_full');
    expect(await codeOf(service.createLink(USER, null))).toBe(
      'create_circle_invite_link:circle_full',
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('maps the raw circle_full of a refresh to resend_circle_invite:circle_full', async () => {
    const { service } = serviceWith({
      lockMemberInCircle: jest.fn().mockResolvedValue(pendingRow({ holds_slot: true })),
      refresh: jest.fn().mockRejectedValue(triggerCircleFull()),
    });
    expect(await codeOf(service.resend(USER, MEMBER))).toBe('resend_circle_invite:circle_full');
  });

  it('batch: a raw circle_full rolls back that item only and reports it as not_created', async () => {
    const { service, repository } = serviceWith({
      availableSlots: jest.fn().mockResolvedValue(2),
      batchItems: jest.fn().mockResolvedValue([
        { is_object: true, display_name: 'A', phone: PHONE },
        { is_object: true, display_name: 'B', phone: '+447700900002' },
      ]),
      insertPhoneInvite: jest
        .fn()
        .mockRejectedValueOnce(triggerCircleFull())
        .mockResolvedValueOnce(payload(false)),
    });
    const result = await service.inviteBatch(USER, [{}, {}]);
    expect(result.not_created).toEqual([
      { phone: PHONE, reason: 'circle_full', display_name: 'A' },
    ]);
    expect(result.created).toHaveLength(1);
    expect(repository.insertPhoneInvite).toHaveBeenCalledTimes(2);
  });

  it('any other database error becomes InviteOperationFailedError (operation + SQLSTATE only)', async () => {
    const leaky = Object.assign(new Error(`duplicate key ${PHONE}`), { code: '23505' });
    const { service } = serviceWith({ insertLinkInvite: jest.fn().mockRejectedValue(leaky) });
    const error = await service.createLink(USER, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteOperationFailedError);
    expect(error).toMatchObject({ operation: 'create_circle_invite_link', sqlState: '23505' });
    expect(String((error as Error).message)).not.toContain(PHONE);
  });

  it('isTriggerCircleFull only matches the bare trigger message', () => {
    expect(isTriggerCircleFull(triggerCircleFull())).toBe(true);
    expect(isTriggerCircleFull(Object.assign(new Error('x:circle_full'), { code: 'P0001' }))).toBe(
      false,
    );
    expect(isTriggerCircleFull(Object.assign(new Error('circle_full'), { code: '23505' }))).toBe(
      false,
    );
  });
});

describe('OwnerInvitesService: unique clash on insert (API-100-26 AC4)', () => {
  it('re-reads the phone and refreshes the row it finds (200, resent)', async () => {
    const { service, repository } = serviceWith({
      insertPhoneInvite: jest.fn().mockResolvedValue(undefined),
      lockMemberByPhone: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(pendingRow({ holds_slot: true, lookup_status: 'pending' })),
    });
    const result = await service.invitePhone(USER, {
      displayName: 'A',
      phone: PHONE,
      relationship: null,
    });
    expect(result.status).toBe(200);
    expect(repository.refresh).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberId: MEMBER, displayName: 'A', relationship: 'friend' }),
      expect.any(String),
    );
  });

  it('nothing found on the re-read → 409 duplicate_membership', async () => {
    const { service } = serviceWith({ insertPhoneInvite: jest.fn().mockResolvedValue(undefined) });
    expect(
      await codeOf(
        service.invitePhone(USER, { displayName: 'A', phone: PHONE, relationship: null }),
      ),
    ).toBe('invite_circle_member_by_phone:duplicate_membership');
  });

  it('batch: the clash re-read gives the SQL outcomes', async () => {
    const clash = (row: LockedMemberRow | undefined) =>
      serviceWith({
        batchItems: jest
          .fn()
          .mockResolvedValue([{ is_object: true, display_name: 'A', phone: PHONE }]),
        insertPhoneInvite: jest.fn().mockResolvedValue(undefined),
        lockMemberByPhone: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(row),
      }).service.inviteBatch(USER, [{}]);
    expect((await clash(undefined)).not_created[0].reason).toBe('duplicate_membership');
    expect((await clash(pendingRow({ status: 'active' }))).skipped[0].reason).toBe(
      'already_active',
    );
    expect((await clash(pendingRow({ lookup_status: 'expired' }))).skipped[0].reason).toBe(
      'already_pending',
    );
    expect(
      (await clash(pendingRow({ status: 'declined', lookup_status: 'canceled' }))).not_created[0]
        .reason,
    ).toBe('duplicate_membership');
  });
});

describe('invite input', () => {
  it('pgTrim trims spaces only, like Postgres trim()', () => {
    expect(pgTrim('  a b  ')).toBe('a b');
    expect(pgTrim('\t a \n')).toBe('\t a \n');
  });

  it('phone body: strings or null; anything else is 422 on its field', () => {
    expect(phoneInviteFromBody({ display_name: 'A', phone: 'p' })).toEqual({
      displayName: 'A',
      phone: 'p',
      relationship: null,
    });
    for (const [body, field] of [
      [null, 'body'],
      ['x', 'body'],
      [{ display_name: 1 }, 'display_name'],
      [{ phone: {} }, 'phone'],
      [{ relationship: ['friend'] }, 'relationship'],
    ] as const) {
      expect(thrown(() => phoneInviteFromBody(body))).toMatchObject({
        code: 'validation:invalid_request',
        details: { field },
      });
    }
  });

  it('link body: no body or no name → null', () => {
    expect(linkInviteFromBody(undefined)).toBeNull();
    expect(linkInviteFromBody({})).toBeNull();
    expect(linkInviteFromBody({ display_name: ' x ' })).toBe(' x ');
  });

  it('batch body: the invites value as sent (missing → null); jsonb-unsafe text → 422', () => {
    expect(batchInvitesFromBody({})).toBeNull();
    expect(batchInvitesFromBody({ invites: 'x' })).toBe('x');
    expect(thrown(() => batchInvitesFromBody({ invites: [{ phone: 'a\u0000' }] }))).toMatchObject({
      details: { field: 'invites' },
    });
  });

  it('member id: Postgres uuid input only', () => {
    expect(requireMemberId(MEMBER.toUpperCase())).toBe(MEMBER.toUpperCase());
    expect(thrown(() => requireMemberId('null'))).toMatchObject({
      details: { field: 'member_id' },
    });
  });

  it('tokens: 64 lowercase hex, the format of new_circle_invite_token(), all different', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newInviteToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(INVITE_TOKEN_FORMAT);
      // Two v4 UUIDs: version nibble 4 and variant 8-b in each half, as gen_random_uuid().
      expect(token[12]).toBe('4');
      expect(token[44]).toBe('4');
      expect('89ab').toContain(token[16]);
      expect('89ab').toContain(token[48]);
    }
  });
});
