export interface FilterClause {
  where: string;
  params: Record<string, unknown>;
}

export function buildWhereClause(
  filters: Record<string, unknown | undefined>,
  columnMap?: Record<string, string>,
): FilterClause {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    const column = columnMap?.[key] ?? key;
    const paramName = `@${key}`;
    conditions.push(`${column} = ${paramName}`);
    params[key] = value;
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function buildTagFilter(tag: string, column = 'tags'): string {
  // Tags are stored as JSON arrays, search within them
  return `(${column} LIKE '%"' || @tag || '"%')`;
}
