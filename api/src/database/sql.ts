/** Dialects are chosen explicitly; bind values are never interpolated into SQL. */
export function sqlFor(db: { isMysql?: boolean }, postgres: string, mysql: string): string {
  return db.isMysql ? mysql : postgres;
}

export function mysqlBindings(sql: string, params: unknown[] = []) {
  let output = '';
  const values: unknown[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      output += sql[index++];
      while (index < sql.length) {
        const next = sql[index++];
        output += next;
        if (next === '\\' && index < sql.length) output += sql[index++];
        else if (next === quote) {
          if (sql[index] === quote) output += sql[index++];
          else break;
        }
      }
    } else if (sql.startsWith('--', index) || sql.startsWith('/*', index)) {
      const block = sql.startsWith('/*', index);
      const end = sql.indexOf(block ? '*/' : '\n', index + 2);
      const stop = end < 0 ? sql.length : end + (block ? 2 : 1);
      output += sql.slice(index, stop);
      index = stop;
    } else {
      const match = sql.slice(index).match(/^\$(\d+)/);
      if (match) {
        const position = Number(match[1]) - 1;
        if (position < 0 || position >= params.length || params[position] === undefined) throw new Error(`Missing SQL parameter ${match[0]}`);
        values.push(params[position]);
        output += '?';
        index += match[0].length;
      } else output += sql[index++];
    }
  }
  return { sql: output, values };
}

/** Preserve all six fractional digits when comparing pagination cursors. */
export function mysqlCursorTime(value?: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) throw new Error('Cursor must use a UTC timestamp');
  return value.replace('T', ' ').replace(/Z$/, '');
}
