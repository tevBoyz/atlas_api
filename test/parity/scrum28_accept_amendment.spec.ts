/**
 * Parity coverage of db/baseline/tests/scrum28_accept_amendment.sql (API-100-13 AC5). One entry per SQL assertion: the
 * name quotes the SQL message, prefixed with its line in the file. Each `it.todo` becomes a real API
 * test in the story that ships the endpoint; `assertion-coverage.spec.ts` keeps this list complete.
 */
describe('scrum28_accept_amendment.sql', () => {
  it.todo('L49: accept_circle_invite still references profiles or location sharing');
  it.todo('L69: could not allocate test phones');
  it.todo('L141: preview own_circle failed: %');
  it.todo('L148: own_circle preview claimed or activated');
  it.todo('L153: own_circle accept did not raise');
  it.todo('L157: own_circle accept got %');
  it.todo('L165: own_circle accept wrote the invite');
  it.todo('L179: accept without location sharing failed: %');
  it.todo('L187: accept turned location sharing on');
  it.todo('L192: accept created a personal circle');
  it.todo('L198: second accept was not idempotent: %');
  it.todo('L205: second accept inserted another row');
  it.todo('L212: preview of own active token failed: %');
  it.todo('L226: preview already_member failed: %');
  it.todo('L233: already_member preview claimed a second row');
  it.todo('L248: owner list hid pending: %');
  it.todo('L267: non-owner list leaked pending or contact fields: %');
  it.todo('L274: non-owner list missed the owner row: %');
  it.todo('L297: expected 5 used before decline, got %');
  it.todo('L308: insert past 5 was allowed before decline');
  it.todo('L312: full insert got %');
  it.todo('L319: decline failed: %');
  it.todo('L326: decline did not set declined');
  it.todo('L330: decline did not release the slot, used=%');
  it.todo('L363: accept at 5 without a profile failed: %');
  it.todo('L366: accept created a profile');
  it.todo('L369: accept created a circle for the no-profile user');
  it.todo('L399: circle_full accept did not raise');
  it.todo('L403: circle_full accept got %');
  it.todo('L411: circle_full accept wrote the invite');
  it.todo('L418: preview circle_full failed: %');
  it.todo('L425: preview circle_full activated the invite');
});
