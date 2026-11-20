import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { type AvatarUploadUrlJson, AvatarsService } from './avatars.service';
import { avatarUploadUrlRequestSchema, avatarUploadUrlSchema } from './profile.schemas';

/**
 * `POST /v1/me/avatar/upload-url` (spec §11.3 P8, API-100-37). Its own per-user rate limit
 * (`avatar_upload`, default 20 per hour: a user changes the photo now and then; each call signs a
 * Storage URL). The answer carries a signed upload token: `cache-control: no-store`.
 */
@Controller('me/avatar')
export class MeAvatarController {
  constructor(private readonly avatars: AvatarsService) {}

  @Post('upload-url')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @Operation('profiles')
  @RateLimit('avatar_upload')
  @ApiContract({
    operationId: 'createAvatarUploadUrl',
    summary: 'A single-use signed URL to upload a new profile photo',
    tag: 'profiles',
    body: { name: 'AvatarUploadUrlRequest', schema: avatarUploadUrlRequestSchema },
    responses: {
      200: {
        description:
          "`PUT` the photo bytes to `upload_url` with `headers` before `expires_at` (once; the bucket also enforces 5 MiB and JPEG/PNG/WebP), then send `object_path` to `PUT /v1/me/profile/avatar`. The object is new for every call (`{uid}/avatar-{uuid}.{ext}`) and in the caller's own folder.",
        name: 'AvatarUploadUrl',
        schema: avatarUploadUrlSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'profiles:invalid_content_type',
      'profiles:file_too_large',
      'profiles:avatar_storage_unavailable',
    ],
  })
  createAvatarUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<AvatarUploadUrlJson> {
    return this.avatars.createUploadUrl(user, body);
  }
}
