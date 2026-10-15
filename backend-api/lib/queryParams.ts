// @ts-nocheck
// Query-string helpers shared by the log search/export routes.

/**
 * Reads a multi-value query parameter in every spelling callers use:
 * `?levels=a`, `?levels=a&levels=b`, `?levels=a,b`, and the bracket form
 * `?levels[]=a`. Express 5 parses queries with the "simple" parser, which
 * leaves `levels[]` as a literal key rather than folding it into `levels`, so
 * both keys have to be read. Returns undefined when neither is present.
 */
function queryArrayParam(query, name) {
  const direct = query?.[name];
  const bracketed = query?.[`${name}[]`];
  if (direct === undefined && bracketed === undefined) return undefined;

  const values = [direct, bracketed]
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return values;
}

module.exports = { queryArrayParam };
