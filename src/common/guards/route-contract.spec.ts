import { Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createTestApp } from '../../testing/test-app';
import { Operation } from '../errors/operation';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { Public } from './route-access';
import { RouteContractCheck, RouteContractError, routeContractProblems } from './route-contract';

@Controller('test-contract-missing')
class MissingOperationController {
  @Get()
  get() {
    return {};
  }
}

@Controller('test-contract-no-code')
class OperationWithoutAuthCodeController {
  @Get()
  @Operation('idempotency')
  get() {
    return {};
  }
}

@Controller('test-contract-public-idempotent')
@Public()
class PublicIdempotentController {
  @Post()
  @Idempotent('optional')
  post() {
    return {};
  }
}

@Controller('test-contract-ok')
@Operation('submit_emergency_alert')
class ClassLevelOperationController {
  @Post()
  @Idempotent('required')
  post() {
    return {};
  }

  @Get('public')
  @Public()
  open() {
    return {};
  }
}

describe('routeContractProblems (API-100-08 AC4, API-100-10)', () => {
  it('accepts public routes without an operation and authenticated routes with one', () => {
    expect(
      routeContractProblems([
        { name: 'A.health', isPublic: true },
        { name: 'B.submit', isPublic: false, operation: 'submit_emergency_alert' },
        {
          name: 'C.markSafe',
          isPublic: false,
          operation: 'mark_incident_safe',
          idempotency: 'required',
        },
      ]),
    ).toEqual([]);
  });

  it('flags an authenticated route without @Operation', () => {
    expect(routeContractProblems([{ name: 'A.x', isPublic: false }])).toEqual([
      "A.x: authenticated route without @Operation('<fn>')",
    ]);
  });

  it('flags an operation without a not_authenticated code', () => {
    expect(
      routeContractProblems([{ name: 'A.x', isPublic: false, operation: 'idempotency' }]),
    ).toEqual([
      "A.x: @Operation('idempotency') has no idempotency:not_authenticated code in the catalogue",
    ]);
  });

  it('flags @Idempotent on a public route', () => {
    expect(
      routeContractProblems([{ name: 'A.x', isPublic: true, idempotency: 'optional' }]),
    ).toEqual(['A.x: @Idempotent() on a @Public() route (keys are per user)']);
  });
});

describe('RouteContractCheck at boot', () => {
  it('the production app passes: every authenticated route declares its operation', async () => {
    const { app } = await createTestApp();
    const routes = app.get(RouteContractCheck).describeRoutes();
    expect(routes).toEqual(
      expect.arrayContaining([
        {
          name: 'HealthController.healthz',
          isPublic: true,
          operation: undefined,
          idempotency: undefined,
          skipRateLimit: true,
        },
        {
          name: 'HealthController.readyz',
          isPublic: true,
          operation: undefined,
          idempotency: undefined,
          skipRateLimit: true,
        },
        {
          name: 'IncidentsController.submit',
          isPublic: false,
          operation: 'submit_emergency_alert',
          idempotency: 'required',
          rateLimitScope: 'user',
        },
      ]),
    );
    await app.close();
  });

  it('reads class-level @Operation and route-level @Public / @Idempotent', async () => {
    const { app } = await createTestApp({ controllers: [ClassLevelOperationController] });
    const routes = app
      .get(RouteContractCheck)
      .describeRoutes()
      .filter((r) => r.name.startsWith('ClassLevelOperationController'));
    expect(routes).toEqual([
      {
        name: 'ClassLevelOperationController.post',
        isPublic: false,
        operation: 'submit_emergency_alert',
        idempotency: 'required',
      },
      {
        name: 'ClassLevelOperationController.open',
        isPublic: true,
        operation: 'submit_emergency_alert',
        idempotency: undefined,
      },
    ]);
    await app.close();
  });

  it.each([
    ['an authenticated route without @Operation', MissingOperationController, /without @Operation/],
    [
      'an operation without a not_authenticated code',
      OperationWithoutAuthCodeController,
      /idempotency:not_authenticated/,
    ],
    [
      '@Idempotent on a public route',
      PublicIdempotentController,
      /@Idempotent\(\) on a @Public\(\)/,
    ],
  ])('fails the boot for %s', async (_name, controller, message) => {
    let app: NestFastifyApplication | undefined;
    const boot = createTestApp({ controllers: [controller] }).then((test) => {
      app = test.app;
    });
    await expect(boot).rejects.toThrow(RouteContractError);
    await expect(boot).rejects.toThrow(message);
    await app?.close();
  });
});
