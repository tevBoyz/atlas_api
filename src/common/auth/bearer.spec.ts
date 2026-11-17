import { bearerToken, MAX_TOKEN_LENGTH } from './bearer';

const JWT_SHAPE = 'aaa.bbb.ccc';

describe('bearerToken (API-100-08 AC1, AC6 malformed header)', () => {
  it.each([
    [`Bearer ${JWT_SHAPE}`],
    [`bearer ${JWT_SHAPE}`],
    [`BEARER ${JWT_SHAPE}`],
    [`Bearer  ${JWT_SHAPE} `],
    ['Bearer a-_1.b-_2.c-_3'],
  ])('accepts %j', (header) => {
    expect(bearerToken(header)).toBe(header.trim().split(/ +/)[1]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['scheme only', 'Bearer'],
    ['scheme and space', 'Bearer '],
    ['other scheme', `Basic ${JWT_SHAPE}`],
    ['no scheme', JWT_SHAPE],
    ['two parts', 'Bearer aaa.bbb'],
    ['four parts', 'Bearer aaa.bbb.ccc.ddd'],
    ['two tokens', `Bearer ${JWT_SHAPE} ${JWT_SHAPE}`],
    ['non base64url', 'Bearer aa+a.bbb.ccc'],
    ['padding', 'Bearer aaa=.bbb.ccc'],
    ['tab separator', `Bearer\t${JWT_SHAPE}`],
    ['several headers', [`Bearer ${JWT_SHAPE}`, `Bearer ${JWT_SHAPE}`]],
    ['too long', `Bearer ${'a'.repeat(MAX_TOKEN_LENGTH)}.b.c`],
  ])('refuses %s', (_name, header) => {
    expect(bearerToken(header)).toBeUndefined();
  });
});
