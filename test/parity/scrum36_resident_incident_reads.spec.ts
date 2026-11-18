/**
 * Parity coverage of db/baseline/tests/scrum36_resident_incident_reads.sql (API-100-13 AC5). One entry per SQL assertion: the
 * name quotes the SQL message, prefixed with its line in the file. Each `it.todo` becomes a real API
 * test in the story that ships the endpoint; `assertion-coverage.spec.ts` keeps this list complete.
 */
describe('scrum36_resident_incident_reads.sql', () => {
  it.todo('L29: read RPC grants wrong');
  it.todo('L51: anonymous open read did not raise');
  it.todo('L55: anonymous open read got %');
  it.todo('L60: anonymous recent read did not raise');
  it.todo('L64: anonymous recent read got %');
  it.todo('L81: open read before submit should be null: %');
  it.todo('L86: recent list should be empty (cancelled excluded): %');
  it.todo('L114: open read failed: %');
  it.todo('L128: default recent list wrong: %');
  it.todo('L137: recent list keys wrong: %');
  it.todo('L144: recent list leaked another user or cancelled');
  it.todo('L148: limit 20 should return all 8');
  it.todo('L151: limit 500 should clamp to 20 and return 8');
  it.todo('L155: limit <= 0 should clamp to 1');
  it.todo('L158: null limit should default to 5');
  it.todo('L165: open read after mark safe should be null: %');
  it.todo('L171: completed incident not first in recent: %');
  it.todo('L176: unexpected incident count %');
});
