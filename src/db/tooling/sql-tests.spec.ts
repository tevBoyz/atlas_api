import { isSuccessMessage, successSentinel } from './sql-tests';
import { lineOfPosition } from './sql-error';

describe('SQL test sentinels (API-100-03)', () => {
  it('derives the sentinel from the file name', () => {
    expect(successSentinel('scrum45_closure_events.sql')).toBe('scrum45_closure_events_ok');
  });

  it.each([
    ['membership_access_window.sql', 'membership_access_window_ok', true],
    ['scrum29_cancel_invite.sql', 'scrum29_cancel_invite_ok +15550100001', true],
    ['scrum29_cancel_invite.sql', 'scrum29_cancel_invite_okay', false],
    ['scrum29_cancel_invite.sql', 'membership_access_window_ok', false],
    ['scrum29_cancel_invite.sql', 'circle_full', false],
  ])('%s raising "%s" passes: %s', (file, message, expected) => {
    expect(isSuccessMessage(file, message)).toBe(expected);
  });
});

describe('lineOfPosition', () => {
  it('maps a 1-based character position to its line', () => {
    const sql = 'select 1;\nselect 2;\nselect oops;';
    expect(lineOfPosition(sql, 1)).toBe(1);
    expect(lineOfPosition(sql, sql.indexOf('oops') + 1)).toBe(3);
  });
});
