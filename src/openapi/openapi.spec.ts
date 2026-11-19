import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Controller, Get, Param, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';

import { API_VERSION } from '../app.constants';
import { AppModule } from '../app.module';
import { Operation } from '../common/errors';
import { Public, SkipRateLimit } from '../common/guards/route-access';
import { Idempotent } from '../common/idempotency';
import { createTestApp, withTestConfig } from '../testing/test-app';
import { ApiContract } from './api-contract.decorator';
import { componentSchema } from './component-schema';
import {
  buildOpenApiDocument,
  OpenApiContractError,
  serializeOpenApiDocument,
  sortKeys,
} from './openapi.document';
import { collectControllers, discoverRoutes } from './route-discovery';

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

const appRoutes = () => discoverRoutes(collectControllers(AppModule));
const appDocument = () => buildOpenApiDocument(appRoutes()) as any;

const okResponse = {
  200: {
    description: 'ok',
    name: 'SampleResponse',
    schema: z.object({ sample_value: z.string() }),
  },
};

@Controller('samples')
class SampleController {
  @Post(':id/submit')
  @Operation('submit_emergency_alert')
  @Idempotent('required')
  @ApiContract({
    operationId: 'submitSample',
    summary: 'Sample',
    tag: 'samples',
    params: z.object({ id: z.uuid() }),
    query: z.object({ limit: z.string().optional() }),
    body: {
      name: 'SampleRequest',
      schema: z.object({ emergency_type: z.enum(['fire']), note: z.string().nullable() }),
    },
    responses: okResponse,
    errors: ['submit_emergency_alert:invalid_type'],
  })
  submit(@Param('id') id: string) {
    return id;
  }

  @Post('optional')
  @Operation('create_circle_invite_link')
  @Idempotent('optional')
  @ApiContract({
    operationId: 'optionalSample',
    summary: 'S',
    tag: 'samples',
    responses: okResponse,
  })
  optional() {
    return {};
  }

  @Get('open')
  @Public()
  @SkipRateLimit()
  @ApiContract({ operationId: 'openSample', summary: 'S', tag: 'samples', responses: okResponse })
  open() {
    return {};
  }
}

@Controller('no-contract')
class NoContractController {
  @Get()
  @Operation('get_my_open_incident')
  get() {
    return {};
  }
}

@Controller('bad')
class CamelCaseController {
  @Get()
  @Operation('get_my_open_incident')
  @ApiContract({
    operationId: 'badCase',
    summary: 'S',
    tag: 't',
    responses: { 200: { description: 'd', name: 'Bad', schema: z.object({ userId: z.string() }) } },
  })
  get() {
    return {};
  }
}

const sampleItemSchema = componentSchema('SampleItem', z.object({ item_id: z.string() }));

@Controller('components')
class ComponentController {
  @Get('one')
  @Operation('get_my_open_incident')
  @ApiContract({
    operationId: 'componentOne',
    summary: 'S',
    tag: 't',
    responses: {
      200: {
        description: 'd',
        name: 'SampleWrapper',
        schema: z.object({ item: sampleItemSchema.nullable() }),
      },
    },
  })
  one() {
    return {};
  }

  @Get('list')
  @Operation('list_my_recent_incidents')
  @ApiContract({
    operationId: 'componentList',
    summary: 'S',
    tag: 't',
    responses: { 200: { description: 'd', schema: z.array(sampleItemSchema) } },
  })
  list() {
    return [];
  }
}

@Controller('unnamed')
class UnnamedObjectController {
  @Get()
  @Operation('get_my_open_incident')
  @ApiContract({
    operationId: 'unnamed',
    summary: 'S',
    tag: 't',
    responses: { 200: { description: 'd', schema: z.object({ a: z.string() }) } },
  })
  get() {
    return {};
  }
}

@Controller('dup')
class DuplicateIdController {
  @Get('a')
  @Operation('get_my_open_incident')
  @ApiContract({ operationId: 'sameId', summary: 'S', tag: 't', responses: {} })
  a() {
    return {};
  }

  @Get('b')
  @Operation('get_my_open_incident')
  @ApiContract({ operationId: 'sameId', summary: 'S', tag: 't', responses: {} })
  b() {
    return {};
  }
}

describe('OpenAPI document (API-100-12)', () => {
  describe('the committed file', () => {
    it('openapi.json is exactly what the code generates (LF, no BOM)', () => {
      const committed = readFileSync(resolve('openapi.json'), 'utf8');
      expect(committed).toBe(serializeOpenApiDocument(appDocument()));
      expect(committed).not.toContain('\r');
    });

    it('the API, package.json and Dart package share one version', () => {
      const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
      const pubspec = readFileSync(resolve('clients/dart/pubspec.yaml'), 'utf8');
      expect(pkg.version).toBe(API_VERSION);
      expect(/^version:\s*(\S+)/m.exec(pubspec)?.[1]).toBe(API_VERSION);
      expect(appDocument().info.version).toBe(API_VERSION);
    });
  });

  describe('determinism', () => {
    it('two generations are byte-identical', () => {
      expect(serializeOpenApiDocument(appDocument())).toBe(serializeOpenApiDocument(appDocument()));
    });

    it('does not depend on the order routes are found in', () => {
      const routes = discoverRoutes([SampleController]);
      expect(serializeOpenApiDocument(buildOpenApiDocument([...routes].reverse()))).toBe(
        serializeOpenApiDocument(buildOpenApiDocument(routes)),
      );
    });

    it('sorts keys at every level and keeps array order', () => {
      expect(JSON.stringify(sortKeys({ b: 1, a: { d: [2, 1], c: 0 } }))).toBe(
        '{"a":{"c":0,"d":[2,1]},"b":1}',
      );
    });

    it('holds no timestamp', () => {
      expect(serializeOpenApiDocument(appDocument())).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    });
  });

  describe('AC1: the routes of the app', () => {
    it('is OpenAPI 3.1 with bearer security and the error envelope', () => {
      const doc = appDocument();
      expect(doc.openapi).toBe('3.1.0');
      expect(doc.components.securitySchemes.bearerAuth).toEqual({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      expect(doc.components.schemas.ErrorEnvelope.required).toEqual(['error']);
      expect(doc.components.schemas.ErrorBody.required).toEqual(['code', 'message', 'details']);
    });

    it('lists only real routes: health, openapi, incidents, locations and config', () => {
      expect(Object.keys(appDocument().paths).sort()).toEqual([
        '/healthz',
        '/readyz',
        '/v1/config/live-location',
        '/v1/incidents',
        '/v1/incidents/{id}/locations',
        '/v1/incidents/{id}/notes',
        '/v1/incidents/{id}/renotify',
        '/v1/me/incidents',
        '/v1/me/incidents/open',
        '/v1/openapi.json',
      ]);
    });

    it('an authenticated route: bearer, 401 with its parity code, 429 with Retry-After', () => {
      const submit = appDocument().paths['/v1/incidents'].post;
      expect(submit.security).toEqual([{ bearerAuth: [] }]);
      expect(submit.responses['401']['x-error-codes']).toEqual([
        'submit_emergency_alert:not_authenticated',
      ]);
      expect(submit.responses['401'].content['application/json'].example.error.code).toBe(
        'submit_emergency_alert:not_authenticated',
      );
      expect(submit.responses['429']['x-error-codes']).toEqual(['rate_limit:exceeded']);
      expect(submit.responses['429'].headers['Retry-After']).toBeDefined();
    });

    it('health routes: public and never 429', () => {
      const health = appDocument().paths['/healthz'].get;
      expect(health.security).toEqual([]);
      expect(health.responses['429']).toBeUndefined();
      expect(health.responses['401']).toBeUndefined();
    });

    it('readiness documents its 503 body, which is not the error envelope', () => {
      const ready = appDocument().paths['/readyz'].get;
      expect(ready.responses['503'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/ReadinessUnavailable',
      });
    });
  });

  describe('AC1-AC3: what decorators contribute', () => {
    const doc = buildOpenApiDocument(discoverRoutes([SampleController])) as any;
    const submit = doc.paths['/v1/samples/{id}/submit'].post;

    it('required Idempotency-Key header and its errors', () => {
      const header = submit.parameters.find((p: any) => p.name === 'Idempotency-Key');
      expect(header).toMatchObject({
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
      expect(submit.responses['400']['x-error-codes']).toEqual(['idempotency:key_required']);
      expect(submit.responses['409']['x-error-codes']).toEqual(['idempotency:in_progress']);
      expect(submit.responses['409'].headers['Retry-After']).toBeDefined();
      expect(submit.responses['422']['x-error-codes']).toEqual([
        'idempotency:invalid_key',
        'idempotency:key_mismatch',
        'submit_emergency_alert:invalid_type',
      ]);
    });

    it('optional Idempotency-Key header is not required, and has no key_required error', () => {
      const optional = doc.paths['/v1/samples/optional'].post;
      expect(optional.parameters.find((p: any) => p.name === 'Idempotency-Key').required).toBe(
        false,
      );
      expect(optional.responses['400']).toBeUndefined();
    });

    it('path and query parameters', () => {
      expect(submit.parameters.find((p: any) => p.name === 'id')).toMatchObject({
        in: 'path',
        required: true,
        schema: { format: 'uuid' },
      });
      expect(submit.parameters.find((p: any) => p.name === 'limit')).toMatchObject({
        in: 'query',
        required: false,
      });
    });

    it('AC2: nullable fields and enums are listed in the request schema', () => {
      const request = doc.components.schemas.SampleRequest;
      expect(request.properties.note.type).toEqual(['string', 'null']);
      expect(request.properties.emergency_type.enum).toEqual(['fire']);
      expect(submit.requestBody.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/SampleRequest',
      });
    });

    it('AC2: the shared enums are published', () => {
      const { schemas } = appDocument().components;
      expect(schemas.EmergencyType.enum).toEqual([
        'medical',
        'domestic_violence',
        'fire',
        'burglary',
        'other',
        'unspecified',
      ]);
      expect(schemas.LocationSource.enum).toEqual(['current', 'last_known', 'unavailable']);
      expect(schemas.IncidentStatus.enum).toContain('resolved');
      expect(schemas.MemberStatus.enum).toContain('declined');
    });

    it('a componentSchema is published once and referenced by $ref', () => {
      const components = buildOpenApiDocument(discoverRoutes([ComponentController])) as any;
      expect(components.components.schemas.SampleItem).toMatchObject({
        type: 'object',
        properties: { item_id: { type: 'string' } },
      });
      expect(components.components.schemas.SampleWrapper.properties.item).toEqual({
        anyOf: [{ $ref: '#/components/schemas/SampleItem' }, { type: 'null' }],
      });
    });

    it('an unnamed array response is inline, its items a $ref', () => {
      const components = buildOpenApiDocument(discoverRoutes([ComponentController])) as any;
      const list = components.paths['/v1/components/list'].get.responses['200'];
      expect(list.content['application/json'].schema).toEqual({
        type: 'array',
        items: { $ref: '#/components/schemas/SampleItem' },
      });
    });

    it('the app publishes IncidentSend and RecentIncident as components', () => {
      const doc = appDocument();
      expect(doc.components.schemas.OpenIncidentResult.properties.open_incident).toEqual({
        anyOf: [{ $ref: '#/components/schemas/IncidentSend' }, { type: 'null' }],
      });
      expect(Object.keys(doc.components.schemas.IncidentSend.properties)).toHaveLength(24);
      expect(
        doc.paths['/v1/me/incidents'].get.responses['200'].content['application/json'].schema,
      ).toEqual({ type: 'array', items: { $ref: '#/components/schemas/RecentIncident' } });
      expect(doc.paths['/v1/me/incidents'].get.parameters).toEqual([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
          required: false,
          schema: expect.objectContaining({ type: 'integer' }),
        }),
      ]);
    });

    it('AC3: operationIds are stable and unique', () => {
      const ids = Object.values(appDocument().paths).flatMap((path: any) =>
        Object.values(path).map((op: any) => op.operationId as string),
      );
      expect(ids.sort()).toEqual([
        'attachIncidentLocation',
        'getHealth',
        'getLiveLocationConfig',
        'getMyOpenIncident',
        'getOpenApiDocument',
        'getReadiness',
        'listMyRecentIncidents',
        'renotifyEmergencyAlert',
        'setIncidentNotes',
        'submitEmergencyAlert',
      ]);
    });
  });

  describe('contract rules', () => {
    const problems = (controller: new () => unknown) => {
      try {
        buildOpenApiDocument(discoverRoutes([controller]));
        return '';
      } catch (error) {
        expect(error).toBeInstanceOf(OpenApiContractError);
        return (error as Error).message;
      }
    };

    it('a route without @ApiContract fails the generation', () => {
      expect(problems(NoContractController)).toContain('route without @ApiContract()');
    });

    it('a property that is not snake_case fails the generation', () => {
      expect(problems(CamelCaseController)).toContain('"userId" is not snake_case');
    });

    it('an unnamed response object fails the generation', () => {
      expect(problems(UnnamedObjectController)).toContain('the 200 response schema needs a name');
    });

    it('a duplicated operationId fails the generation', () => {
      expect(problems(DuplicateIdController)).toContain('operationId already used');
    });
  });
});

describe('GET /v1/openapi.json (API-100-12 AC4)', () => {
  const close = (app: NestFastifyApplication) => app.close();

  it('outside production: public, and identical to the committed document', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(JSON.parse(readFileSync(resolve('openapi.json'), 'utf8')));
    await close(app);
  });

  it('test-only routes of an app never appear in the served document', async () => {
    const { app } = await createTestApp({ controllers: [NoContractController] });
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(Object.keys(res.json<{ paths: object }>().paths)).not.toContain('/v1/no-contract');
    await close(app);
  });

  it('OPENAPI_ENABLED=false → 404 in the error envelope', async () => {
    const { app } = await createTestApp({}, withTestConfig({ OPENAPI_ENABLED: 'false' }));
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'http:not_found' } });
    await close(app);
  });

  it('production → 404, even with OPENAPI_ENABLED=true', async () => {
    const { app } = await createTestApp(
      {},
      withTestConfig({
        NODE_ENV: 'production',
        OPENAPI_ENABLED: 'true',
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/db',
        REDIS_URL: 'redis://127.0.0.1:1',
        SUPABASE_URL: 'http://127.0.0.1:1',
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(404);
    await close(app);
  });
});
