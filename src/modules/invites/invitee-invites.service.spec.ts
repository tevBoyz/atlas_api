import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { AuthenticatedUser } from '../../common/auth';
import type { ApiConfigService } from '../../config';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import { avatarUrlSql } from '../circles/circles.repository';
import { incomingInviteSchema } from './invite.schemas';
import type { InviteeInvitesRepository } from './invitee-invites.repository';
import { InviteeInvitesService } from './invitee-invites.service';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  issuer: 'supabase',
  sessionId: null,
  email: null,
  phone: null,
};

const ELEMENT = {
  member_id: '33333333-3333-4333-8333-333333333333',
  circle_id: '22222222-2222-4222-8222-222222222222',
  status: 'pending',
  owner_name: 'Owner',
  invited_at: '2026-11-22T10:00:00.000000+00:00',
  invite_expires_at: null,
  invite_token: 'x',
};

describe('GET /v1/me/invites: owner_avatar_url (SCRUM-33, D46)', () => {
  it('the incoming list is built with the configured avatar origin and bucket', async () => {
    const listIncoming = jest.fn().mockResolvedValue([]);
    const repository = {
      useUtcTimestamps: jest.fn().mockResolvedValue(undefined),
      lockCaller: jest.fn().mockResolvedValue(undefined),
      authPhone: jest.fn().mockResolvedValue(null),
      lockClaimCandidates: jest.fn().mockResolvedValue([]),
      listIncoming,
    };
    const tx = { transaction: (run: (sp: object) => Promise<unknown>) => run(tx) };
    const database = { db: { transaction: (run: (t: object) => Promise<unknown>) => run(tx) } };
    const values: Record<string, string> = {
      SUPABASE_URL: 'https://example-project.supabase.co/',
      AVATARS_BUCKET: 'avatars',
    };
    const config = { get: (key: string) => values[key] };
    const service = new InviteeInvitesService(
      database as unknown as DatabaseService,
      repository as unknown as InviteeInvitesRepository,
      { record: jest.fn() } as unknown as AuditService,
      config as unknown as ApiConfigService,
    );
    await expect(service.listIncoming(USER)).resolves.toEqual([]);
    expect(listIncoming).toHaveBeenCalledWith(tx, USER.id, null, {
      origin: 'https://example-project.supabase.co',
      bucket: 'avatars',
    });
  });

  it('the element schema requires owner_avatar_url: a string or null', () => {
    expect(incomingInviteSchema.safeParse({ ...ELEMENT, owner_avatar_url: null }).success).toBe(
      true,
    );
    expect(
      incomingInviteSchema.safeParse({ ...ELEMENT, owner_avatar_url: 'https://cdn.example/a.png' })
        .success,
    ).toBe(true);
    expect(incomingInviteSchema.safeParse(ELEMENT).success).toBe(false);
  });

  it('the URL rule is the preview’s: blank → null, http(s) kept, else the public storage URL', () => {
    const query = new PgDialect().sqlToQuery(
      avatarUrlSql(sql`p.avatar_path`, { origin: 'https://h', bucket: 'avatars' }),
    );
    expect(query.sql).toContain("nullif(trim(coalesce(p.avatar_path, '')), '')");
    expect(query.sql).toContain("~* '^https?://'");
    expect(query.params).toContain('https://h/storage/v1/object/public/avatars/');
  });
});
