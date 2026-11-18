/**
 * Parity coverage of db/baseline/tests/scrum45_closure_events.sql (API-100-13 AC5). One entry per SQL assertion: the
 * name quotes the SQL message, prefixed with its line in the file. Each `it.todo` becomes a real API
 * test in the story that ships the endpoint; `assertion-coverage.spec.ts` keeps this list complete.
 */
describe('scrum45_closure_events.sql', () => {
  it.todo('L42: incident_events grants are not select-only for authenticated');
  it.todo('L46: incident_events RLS disabled');
  it.todo('L53: incident_events should have exactly one (select) policy: %');
  it.todo('L61: incidents_select_active_member lost _is_active_circle_member');
  it.todo('L114: live attach failed: %');
  it.todo('L128: mark safe payload failed: %');
  it.todo('L148: events after mark safe wrong: %');
  it.todo('L158: closure_notified detail wrong: %');
  it.todo('L168: incident_closed detail wrong');
  it.todo('L176: mark safe retry changed the row: %');
  it.todo('L181: mark safe retry added events: %');
  it.todo('L189: attach after close did not raise');
  it.todo('L193: attach after close got %');
  it.todo('L199: unavailable attach after close did not raise');
  it.todo('L203: unavailable attach after close got %');
  it.todo('L212: late ping reopened or rewrote the incident');
  it.todo('L217: renotify after close did not raise');
  it.todo('L221: renotify after close got %');
  it.todo('L230: resident sees % events');
  it.todo('L239: active member sees % events');
  it.todo('L244: active member cannot see the closed incident');
  it.todo('L250: member inserted an event');
  it.todo('L257: member updated an incident');
  it.todo('L268: pending user sees % events');
  it.todo('L277: outsider sees % events');
  it.todo('L282: outsider sees the incident');
  it.todo('L292: resident updated an incident directly');
  it.todo('L299: resident inserted an incident directly');
  it.todo('L315: member details after close wrong: %');
  it.todo('L327: submit after close failed: %');
});
