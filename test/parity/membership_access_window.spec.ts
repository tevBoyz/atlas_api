/**
 * Parity coverage of db/baseline/tests/membership_access_window.sql (API-100-13 AC5). One entry per SQL assertion: the
 * name quotes the SQL message, prefixed with its line in the file. Each `it.todo` becomes a real API
 * test in the story that ships the endpoint; `assertion-coverage.spec.ts` keeps this list complete.
 */
describe('membership_access_window.sql', () => {
  it.todo('L44: incidents_select_active_member does not use _is_active_circle_member_since');
  it.todo('L52: incidents_select_active_member has a raw members subquery (RLS recursion)');
  it.todo('L84: owner row has no activated_at');
  it.todo('L121: pending row has activated_at');
  it.todo('L148: activation did not stamp now(): %');
  it.todo('L159: B should deliver to early, member, removed: %');
  it.todo('L189: owner backdated activated_at: %');
  it.todo('L195: resident sees % own incidents');
  it.todo('L202: resident recent list has % of own incidents');
  it.todo('L207: resident sees no events on A');
  it.todo('L217: early member sees % incidents');
  it.todo('L227: late member sees pre-join incident A via RLS');
  it.todo('L232: member cannot see post-join incident B via RLS');
  it.todo('L237: list_responder_incidents leaks A: %');
  it.todo('L240: list_responder_incidents misses B: %');
  it.todo('L245: details leak A: %');
  it.todo('L249: details A got %');
  it.todo('L255: details B wrong: %');
  it.todo('L260: late member sees % events on A');
  it.todo('L265: member sees no events on B');
  it.todo('L270: counts B wrong: %');
  it.todo('L275: ack B wrong: %');
  it.todo('L280: member sees % own delivery rows');
  it.todo('L290: joiner sees % incidents');
  it.todo('L294: joiner list not empty');
  it.todo('L299: joiner sees % events');
  it.todo('L304: joiner sees own stray delivery row');
  it.todo('L309: details leak B to joiner: %');
  it.todo('L313: joiner details B got %');
  it.todo('L319: counts leak B to joiner: %');
  it.todo('L323: joiner counts B got %');
  it.todo('L329: joiner acked B: %');
  it.todo('L333: joiner ack B got %');
  it.todo('L344: pending user sees % incidents');
  it.todo('L353: outsider sees % incidents');
  it.todo('L358: outsider sees % events');
  it.todo('L362: outsider list not empty');
  it.todo('L367: details leak B to outsider: %');
  it.todo('L371: outsider details B got %');
  it.todo('L382: removed-to-be member cannot see B before removal');
  it.todo('L396: removed member sees % incidents');
  it.todo('L401: removed member sees % events');
  it.todo('L405: removed member list not empty');
  it.todo('L410: details leak B to removed member: %');
  it.todo('L414: removed details B got %');
  it.todo('L426: left member sees % incidents');
  it.todo('L431: left member sees % events');
  it.todo('L435: left member list not empty');
  it.todo('L440: left member acked B: %');
  it.todo('L444: left member ack B got %');
  it.todo('L456: declined row has activated_at');
});
