import { mysqlParameters } from './mysql-parameters';

describe('MySQL numbered parameter binding', () => {
  it('binds reordered and repeated values without interpolating user input', () => {
    expect(mysqlParameters('SELECT $2, $1, $2', ["x'; DROP TABLE users; --", 42]))
      .toEqual({ sql: 'SELECT ?, ?, ?', values: [42, "x'; DROP TABLE users; --", 42] });
  });
  it('ignores literals, identifiers and comments', () => {
    const sql = "SELECT '$1', \"$2\", `$3`, $1 /* $4 */ -- $5\n# $6\n";
    expect(mysqlParameters(sql, [7])).toEqual({ sql: sql.replace(', $1 /*', ', ? /*'), values: [7] });
  });
  it('rejects missing parameters and preserves nulls', () => {
    expect(() => mysqlParameters('SELECT $2', [1])).toThrow('Missing SQL parameter');
    expect(mysqlParameters('SELECT $1', [null]).values).toEqual([null]);
  });
});
