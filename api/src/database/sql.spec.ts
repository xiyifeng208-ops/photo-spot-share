import { mysqlBindings, mysqlCursorTime } from './sql';

describe('MySQL bind parameters', () => {
  it('reorders repeated parameters without interpolating values', () => {
    expect(mysqlBindings('SELECT $2, $1, $2', ["x' OR 1=1", 7])).toEqual({
      sql: 'SELECT ?, ?, ?', values: [7, "x' OR 1=1", 7],
    });
  });
  it('does not treat strings, identifiers or comments as parameters', () => {
    expect(mysqlBindings("SELECT '$1', `$2`, $1 /* $2 */ -- $3\n", [9])).toEqual({
      sql: "SELECT '$1', `$2`, ? /* $2 */ -- $3\n", values: [9],
    });
  });
  it('rejects missing parameters and preserves NULL', () => {
    expect(() => mysqlBindings('SELECT $2', [1])).toThrow('Missing SQL parameter');
    expect(mysqlBindings('SELECT $1', [null]).values).toEqual([null]);
  });
  it('preserves microseconds in cursor comparisons', () => {
    expect(mysqlCursorTime('2026-10-08T11:00:00.123456Z')).toBe('2026-10-08 11:00:00.123456');
  });
});
