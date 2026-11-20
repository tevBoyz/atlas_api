import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';

import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_STORAGE,
  type AvatarStorage,
} from './avatar-storage';
import { FAKE_UPLOAD_PREFIX, MemoryAvatarStorage } from './memory-avatar-storage';

/**
 * Serves the upload URLs of {@link MemoryAvatarStorage} (`AVATAR_STORAGE=memory`, never in
 * production): `PUT /__fake-storage/upload/sign/{bucket}/{path}?token=...` with the photo bytes, as
 * the app would send them to Supabase Storage. A plain Fastify route outside the API contract (not
 * under `/v1`, not in OpenAPI, no bearer token: the signed token is the permission). Not registered
 * at all with the Supabase implementation.
 */
@Injectable()
export class FakeStorageRoute implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(AVATAR_STORAGE) private readonly storage: AvatarStorage,
  ) {}

  onModuleInit(): void {
    const storage = this.storage;
    if (!(storage instanceof MemoryAvatarStorage)) return;
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    void fastify.register((instance, _options, done) => {
      instance.addContentTypeParser(
        [...Object.keys(AVATAR_CONTENT_TYPES), 'application/octet-stream'],
        { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES + 1 },
        (_request, body, next) => next(null, body),
      );
      instance.put(
        `${FAKE_UPLOAD_PREFIX}/:bucket/*`,
        { bodyLimit: AVATAR_MAX_BYTES + 1 },
        async (request, reply) => {
          const params = request.params as { bucket: string; '*': string };
          const token = (request.query as { token?: string }).token;
          const body = request.body as Buffer | undefined;
          const result = storage.receive(
            params.bucket,
            params['*'],
            token,
            request.headers['content-type'],
            body?.length ?? 0,
          );
          void reply.header('cache-control', 'no-store');
          return reply.status(result.status).send(result.body);
        },
      );
      done();
    });
  }
}
