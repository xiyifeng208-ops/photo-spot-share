/** Bind numbered parameters; leave quoted text, identifiers and comments untouched. */
export function mysqlParameters(sql: string, params: unknown[]) {
  const values: unknown[] = [];
  const token = /'(?:''|\\[\s\S]|[^'\\])*'|"(?:""|\\[\s\S]|[^"\\])*"|`(?:``|[^`])*`|--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|\$(\d+)/g;
  const statement = sql.replace(token, (match, position: string | undefined) => {
    if (position === undefined) return match;
    const index = Number(position) - 1;
    if (index < 0 || index >= params.length || params[index] === undefined) throw new Error(`Missing SQL parameter $${position}`);
    values.push(params[index]);
    return '?';
  });
  return { sql: statement, values };
}
