/**
 * Parity coverage of db/baseline/tests/member_names_expired_invites.sql (API-100-13 AC5). One entry per SQL assertion: the
 * name quotes the SQL message, prefixed with its line in the file. Each `it.todo` becomes a real API
 * test in the story that ships the endpoint; `assertion-coverage.spec.ts` keeps this list complete.
 */
describe('member_names_expired_invites.sql', () => {
  it.todo('L54: accept_circle_invite name write missing or touches profiles/location');
  it.todo('L65: profiles RLS was opened to circle members');
  it.todo('L70: _member_profile_name is callable by clients');
  it.todo('L89: could not allocate test phones');
  it.todo('L137: setup failed: %');
  it.todo('L144: link placeholder changed: %');
  it.todo('L156: link accept failed: %');
  it.todo('L162: accept did not store the profile name: %');
  it.todo('L195: owner list did not show profile name: %');
  it.todo('L202: pending link invite lost its placeholder: %');
  it.todo('L208: no-profile fallback failed: %');
  it.todo('L214: owner row name failed: %');
  it.todo('L235: expired counted in capacity: %');
  it.todo('L244: owner list missing expired row: %');
  it.todo('L248: stored status changed: %');
  it.todo('L264: member list leaked pending/expired/contact: %');
  it.todo('L269: member list did not show profile name: %');
  it.todo('L281: expired accept did not raise');
  it.todo('L285: expired accept got %');
  it.todo('L302: fill failed: %');
  it.todo('L307: resend at 5/5 did not raise');
  it.todo('L311: resend at 5/5 got %');
  it.todo('L317: failed resend wrote the row');
  it.todo('L334: cancel on expired failed: %');
  it.todo('L339: cancel on expired did not decline');
  it.todo('L342: canceled expired token lookup wrong');
  it.todo('L346: cancel on expired changed capacity: %');
  it.todo('L353: cancel did not free a slot: %');
  it.todo('L362: resend on expired failed: %');
  it.todo('L365: resent token is not pending');
  it.todo('L370: resend did not take the slot: %');
  it.todo('L376: resent row not listed pending: %');
  it.todo('L391: contact decline failed: %');
  it.todo('L404: setup re-run after decline failed: %');
  it.todo('L418: setup re-run left an unusable invite');
  it.todo('L421: setup re-run token does not look up as pending: %');
  it.todo('L425: old declined token still resolves');
  it.todo('L437: contact preview after re-run failed: %');
  it.todo('L452: refill failed: %');
  it.todo('L458: setup re-run at 5/5 failed: %');
});
