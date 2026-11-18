import { Controller, Get, Injectable, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';

import { DomainError } from '../common/errors/domain-error';
import { Public } from '../common/guards/route-access';
import { ApiConfigService } from '../config';
import { ApiContract } from './api-contract.decorator';
import { buildOpenApiDocument } from './openapi.document';
import { discoverRoutes } from './route-discovery';

/** Builds the document of the running app once, on first use. */
@Injectable()
export class OpenApiService {
  private document?: Record<string, unknown>;

  constructor(private readonly discovery: DiscoveryService) {}

  get(): Record<string, unknown> {
    this.document ??= buildOpenApiDocument(
      discoverRoutes(
        this.discovery
          .getControllers()
          .map((wrapper) => wrapper.metatype as Type<unknown> | null)
          .filter((metatype): metatype is Type<unknown> => metatype !== null),
      ).filter((route) => route.contract !== undefined),
    );
    return this.document;
  }
}

@Controller()
@Public()
export class OpenApiController {
  constructor(
    private readonly openApi: OpenApiService,
    private readonly config: ApiConfigService,
  ) {}

  /** API-100-12 AC4: served outside production while OPENAPI_ENABLED is on; 404 in production. */
  @Get('openapi.json')
  @ApiContract({
    operationId: 'getOpenApiDocument',
    summary: 'The OpenAPI document of this API (never served in production)',
    tag: 'meta',
    responses: {
      200: {
        description: 'OpenAPI 3.1 document',
        name: 'OpenApiDocument',
        schema: z.looseObject({}),
      },
    },
    errors: ['http:not_found'],
  })
  document(): Record<string, unknown> {
    if (this.config.isProduction || !this.config.get('OPENAPI_ENABLED')) {
      throw new DomainError('http:not_found');
    }
    return this.openApi.get();
  }
}
