import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const roots = ['packages/core/src', 'packages/postgres/src', 'packages/postgres/migrations', 'packages/second_brain/src', 'apps/cli/src'];
// SQL keywords, rather than bare dotted names such as work kind 'garmin.collect'.
const schemaSql = /\b(?:from|join|into|update|table|view|exists|references|truncate|delete\s+from|alter\s+table|drop\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?"?garmin"?\s*\.|\bsearch_path\s*(?:=|to)\s*[^;\n]*\bgarmin\b/i;
function hasSchemaSql(source:string):boolean {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return [source, uncommented].some(text => schemaSql.test(text) || /\bfrom\s+[^;\n`]*?,\s*(?:only\s+)?"?garmin"?\s*\./i.test(text));
}
function files(dir:string):string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && /\.(?:ts|js|mjs|sql)$/.test(entry.name) ? [path] : [];
  });
}
it('core 소스가 Garmin schema SQL에 의존하지 않는다', () => {
  for (const sql of ["select '--' AS marker from garmin.day_summary", 'select * from garmin.day_summary', 'JOIN "garmin" . day_summary', 'create table if not exists garmin.x (id int)', 'set search_path = public, garmin', 'select * from brain.users u, garmin.day_summary d', 'select * from /* source */ garmin.day_summary', 'select * from only garmin.x', 'select * from -- source\n garmin.x', 'select * from brain.users,\n garmin.x']) expect(hasSchemaSql(sql), sql).toBe(true);
  expect(hasSchemaSql("kind = 'garmin.collect'")).toBe(false);
  const matches = roots.flatMap(dir => files(join(root, dir))).filter(path => hasSchemaSql(readFileSync(path, 'utf8'))).map(path => relative(root, path));
  expect(matches).toEqual([]);
});
