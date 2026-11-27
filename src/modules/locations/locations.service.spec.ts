import type { AuthenticatedUser } from '../../common/auth';
import type { DatabaseService } from '../../db/database.service';
import type { IncidentPostCommitRunner } from '../incidents/incident-post-commit';
import { IncidentOperationFailedError } from '../incidents/incident-transaction';
import type { IncidentsRepository } from '../incidents/incidents.repository';
import { parseAttachLocationBody } from './location-input';
import type { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '99999999-9999-4999-8999-999999999999',
  email: null,
  phone: null,
};
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const PING = parseAttachLocationBody({
  location_source: 'current',
  location_lat: 12.3456789,
  location_lng: -45.6789012,
  location_accuracy_m: 7.5,
  location_captured_at: '2026-11-19T10:00:00Z',
});

function serviceWith(
  locations: Partial<Record<keyof LocationsRepository, jest.Mock>> = {},
  incidents: Partial<Record<keyof IncidentsRepository, jest.Mock>> = {},
) {
  const locationsRepo = {
    useInputSettings: jest.fn().mockResolvedValue(undefined),
    inputValidity: jest.fn().mockResolvedValue([true]),
    checkArguments: jest.fn().mockResolvedValue(null),
    writeLocation: jest.fn().mockResolvedValue({ circle_id: null, location_lat: 12.3456789 }),
    ...locations,
  };
  const incidentsRepo = {
    lockOwnIncident: jest
      .fn()
      .mockResolvedValue({ id: INCIDENT_ID, status: 'active', sharing_ended: false }),
    sharedResult: jest.fn().mockResolvedValue({ circle_id: null, location_lat: 1 }),
    writePlace: jest.fn().mockResolvedValue(undefined),
    ...incidents,
  };
  const postCommit = { afterLocation: jest.fn().mockResolvedValue(undefined) };
  const database = { db: { transaction: (run: (tx: object) => Promise<unknown>) => run({}) } };
  const service = new LocationsService(
    database as unknown as DatabaseService,
    incidentsRepo as unknown as IncidentsRepository,
    locationsRepo,
    postCommit as unknown as IncidentPostCommitRunner,
  );
  return { service, locationsRepo, incidentsRepo, postCommit };
}

describe('LocationsService.attach (API-100-17)', () => {
  it('argument checks come before the row lock', async () => {
    const { service, incidentsRepo } = serviceWith({
      checkArguments: jest.fn().mockResolvedValue('invalid_location'),
    });
    await expect(service.attach(USER, INCIDENT_ID, PING)).rejects.toMatchObject({
      code: 'attach_incident_location:invalid_location',
    });
    expect(incidentsRepo.lockOwnIncident).not.toHaveBeenCalled();
  });

  it('a value Postgres refuses is 422 on its field, before the function checks', async () => {
    const { service, locationsRepo } = serviceWith({
      inputValidity: jest.fn().mockResolvedValue([false]),
    });
    await expect(service.attach(USER, INCIDENT_ID, PING)).rejects.toMatchObject({
      code: 'validation:invalid_request',
      details: { field: 'location_captured_at' },
    });
    expect(locationsRepo.checkArguments).not.toHaveBeenCalled();
  });

  it.each([
    ['resolved', false],
    ['cancelled', false],
    ['activating', false],
    ['active', true],
  ])('status %s with sharing_ended=%p is not_open', async (status, sharingEnded) => {
    const { service, locationsRepo } = serviceWith(
      {},
      {
        lockOwnIncident: jest
          .fn()
          .mockResolvedValue({ id: INCIDENT_ID, status, sharing_ended: sharingEnded }),
      },
    );
    await expect(service.attach(USER, INCIDENT_ID, PING)).rejects.toMatchObject({
      code: 'attach_incident_location:not_open',
    });
    expect(locationsRepo.writeLocation).not.toHaveBeenCalled();
  });

  it('an older fix answers the current row and runs no hook', async () => {
    const { service, postCommit } = serviceWith({
      writeLocation: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.attach(USER, INCIDENT_ID, PING)).resolves.toEqual({
      circle_id: null,
      location_lat: 1,
    });
    expect(postCommit.afterLocation).not.toHaveBeenCalled();
  });

  it('a stored fix runs the hook with ids only', async () => {
    const { service, postCommit } = serviceWith();
    await service.attach(USER, INCIDENT_ID, PING);
    expect(postCommit.afterLocation).toHaveBeenCalledWith({
      incident_id: INCIDENT_ID,
      resident_id: USER.id,
      circle_id: null,
    });
  });

  it('a database error loses the coordinates, keeping the SQLSTATE', async () => {
    const cause = Object.assign(new Error('failing row contains (12.3456789, -45.6789012)'), {
      code: '23514',
    });
    const { service } = serviceWith({
      writeLocation: jest
        .fn()
        .mockRejectedValue(new Error('params: 12.3456789,-45.6789012', { cause })),
    });
    const error = await service.attach(USER, INCIDENT_ID, PING).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncidentOperationFailedError);
    expect(error).toMatchObject({ operation: 'attach_incident_location', sqlState: '23514' });
    expect(JSON.stringify(error)).not.toMatch(/12\.345|45\.678/);
    expect((error as Error).message).not.toMatch(/12\.345|45\.678/);
    expect((error as Error).cause).toBeUndefined();
  });
});
