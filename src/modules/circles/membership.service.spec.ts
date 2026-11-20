import type { Logger } from 'pino';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError, type ErrorCode } from '../../common/errors';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import {
  type MembershipEndedEvent,
  type MembershipPostCommitHook,
  MembershipPostCommitRunner,
} from './membership-post-commit';
import type { LockedMembershipRow, MembershipRepository } from './membership.repository';
import { MembershipOperationFailedError, MembershipService } from './membership.service';

const OWNER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  issuer: 'supabase',
  sessionId: null,
  email: null,
  phone: null,
};
const MEMBER: AuthenticatedUser = { ...OWNER, id: '33333333-3333-4333-8333-333333333333' };
const CIRCLE = '22222222-2222-4222-8222-222222222222';
const ROW: LockedMembershipRow = {
  id: '44444444-4444-4444-8444-444444444444',
  circle_id: CIRCLE,
  role: 'member',
  status: 'active',
  user_id: MEMBER.id,
};

const logger = () => ({ warn: jest.fn() }) as unknown as Logger & { warn: jest.Mock };

function setup(
  overrides: Partial<Record<keyof MembershipRepository, jest.Mock>> = {},
  options: { auditFails?: boolean; hooks?: MembershipPostCommitHook[] } = {},
) {
  const repository = {
    lockMemberInCircle: jest.fn().mockResolvedValue(ROW),
    circleExists: jest.fn().mockResolvedValue(true),
    isCircleOwner: jest.fn().mockResolvedValue(true),
    lockActiveMembership: jest.fn().mockResolvedValue(ROW),
    deleteMember: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  const timeline: string[] = [];
  const database = {
    db: {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        timeline.push('begin');
        try {
          const result = await work({});
          timeline.push('commit');
          return result;
        } catch (error) {
          timeline.push('rollback');
          throw error;
        }
      },
    },
  } as unknown as DatabaseService;
  const audit = {
    record: jest.fn().mockImplementation(() => {
      timeline.push('audit');
      return options.auditFails ? Promise.reject(new Error('down')) : Promise.resolve();
    }),
  };
  const ended: MembershipEndedEvent[] = [];
  const hook: MembershipPostCommitHook = {
    afterMembershipEnded: (event) => {
      timeline.push('hook');
      ended.push(event);
    },
  };
  const log = logger();
  const runner = new MembershipPostCommitRunner(options.hooks ?? [hook], log);
  const service = new MembershipService(
    database,
    repository,
    audit as unknown as AuditService,
    runner,
  );
  return { service, repository, audit, ended, timeline, log };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MembershipService (API-100-32)', () => {
  it('remove: parity body (jsonb key order), delete + audit inside, hook after commit', async () => {
    const { service, repository, audit, ended, timeline } = setup({
      lockMemberInCircle: jest.fn().mockResolvedValue({ ...ROW }),
    });
    const body = await service.remove(OWNER, CIRCLE, ROW.id);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ removed: true, circle_id: CIRCLE, member_id: ROW.id }),
    );
    expect(repository.lockMemberInCircle).toHaveBeenCalledWith({}, ROW.id, CIRCLE);
    expect(repository.deleteMember).toHaveBeenCalledWith({}, ROW.id);
    expect(audit.record).toHaveBeenCalledWith(
      {
        action: 'circle.member.removed',
        actor_user_id: OWNER.id,
        actor_session_id: null,
        target_type: 'circle_member',
        target_id: ROW.id,
        detail: { circle_id: CIRCLE, member_user_id: MEMBER.id, previous_status: 'active' },
      },
      {},
    );
    await flush();
    expect(timeline).toEqual(['begin', 'audit', 'commit', 'hook']);
    expect(ended).toEqual([
      {
        reason: 'removed',
        circle_id: CIRCLE,
        member_id: ROW.id,
        user_id: MEMBER.id,
        actor_user_id: OWNER.id,
      },
    ]);
  });

  it('remove: codes in order; null ids are not_found; nothing deleted or announced', async () => {
    const cases: Array<[Partial<Record<keyof MembershipRepository, jest.Mock>>, ErrorCode]> = [
      [
        { lockMemberInCircle: jest.fn().mockResolvedValue(undefined) },
        'remove_circle_member:not_found',
      ],
      [
        { isCircleOwner: jest.fn().mockResolvedValue(false) },
        'remove_circle_member:not_authorized',
      ],
      [
        { lockMemberInCircle: jest.fn().mockResolvedValue({ ...ROW, role: 'owner' }) },
        'remove_circle_member:cannot_remove_owner',
      ],
    ];
    for (const [overrides, code] of cases) {
      const { service, repository, ended } = setup(overrides);
      await expect(service.remove(OWNER, CIRCLE, ROW.id)).rejects.toEqual(new DomainError(code));
      expect(repository.deleteMember).not.toHaveBeenCalled();
      await flush();
      expect(ended).toEqual([]);
    }
    const { service, repository } = setup();
    await expect(service.remove(OWNER, CIRCLE, null)).rejects.toEqual(
      new DomainError('remove_circle_member:not_found'),
    );
    await expect(service.remove(OWNER, null, ROW.id)).rejects.toEqual(
      new DomainError('remove_circle_member:not_found'),
    );
    expect(repository.lockMemberInCircle).not.toHaveBeenCalled();
  });

  it('leave: codes in the SQL order; success body and reason left', async () => {
    const cases: Array<[Partial<Record<keyof MembershipRepository, jest.Mock>>, ErrorCode]> = [
      [{ circleExists: jest.fn().mockResolvedValue(false) }, 'leave_safety_circle:not_found'],
      [{ isCircleOwner: jest.fn().mockResolvedValue(true) }, 'leave_safety_circle:is_owner'],
      [
        {
          isCircleOwner: jest.fn().mockResolvedValue(false),
          lockActiveMembership: jest.fn().mockResolvedValue(undefined),
        },
        'leave_safety_circle:not_authorized',
      ],
    ];
    for (const [overrides, code] of cases) {
      const { service, repository } = setup(overrides);
      await expect(service.leave(MEMBER, CIRCLE)).rejects.toEqual(new DomainError(code));
      expect(repository.deleteMember).not.toHaveBeenCalled();
    }
    await expect(setup().service.leave(MEMBER, null)).rejects.toEqual(
      new DomainError('leave_safety_circle:not_found'),
    );
    const { service, ended } = setup({ isCircleOwner: jest.fn().mockResolvedValue(false) });
    const body = await service.leave(MEMBER, CIRCLE);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ left: true, circle_id: CIRCLE, member_id: ROW.id }),
    );
    await flush();
    expect(ended.map((e) => [e.reason, e.actor_user_id])).toEqual([['left', MEMBER.id]]);
  });

  it('a rollback (audit fails) announces nothing and is a 500 error without personal data', async () => {
    const { service, ended, timeline } = setup({}, { auditFails: true });
    const error = await service.remove(OWNER, CIRCLE, ROW.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MembershipOperationFailedError);
    expect((error as Error).message).toBe('remove_circle_member failed in the database');
    await flush();
    expect(timeline).toEqual(['begin', 'audit', 'rollback']);
    expect(ended).toEqual([]);
  });

  it('end refuses the owner row and a row that was not deleted (programming errors)', async () => {
    const { service } = setup();
    const change = { tx: {} as never, ended: [] };
    await expect(service.end(change, { ...ROW, role: 'owner' }, 'removed', OWNER)).rejects.toThrow(
      'the owner row cannot end',
    );
    const gone = setup({ deleteMember: jest.fn().mockResolvedValue(false) });
    await expect(gone.service.end(change, ROW, 'removed', OWNER)).rejects.toThrow(
      'was not deleted',
    );
    expect(change.ended).toEqual([]);
  });

  it('a failing hook is logged (ids only) and never fails the committed change', async () => {
    const failing: MembershipPostCommitHook = {
      afterMembershipEnded: () => Promise.reject(new Error('socket server down')),
    };
    const { service, log } = setup({}, { hooks: [failing] });
    await expect(service.remove(OWNER, CIRCLE, ROW.id)).resolves.toMatchObject({ removed: true });
    await flush();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'removed', circle_id: CIRCLE, member_id: ROW.id }),
      'membership post-commit hook failed',
    );
    const [fields] = log.warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).not.toHaveProperty('user_id');
  });
});
