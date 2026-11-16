/** Never act on production resources, even if their labels or ledger are forged. */
export function assertUnprotected(name: string | undefined, labels: Record<string, string> | undefined): void {
  const values = [name?.replace(/^\//, ''), labels?.['com.docker.compose.project'], labels?.['com.docker.compose.service'], labels?.['com.docker.compose.volume'], labels?.['com.docker.compose.network']];
  if (values.some(value => value === 'second-brain-postgres-1' || value === 'second-brain-pg' || value === 'second-brain' || value === 'sjtech' || value === 'sjtech-db')) throw new Error('protected operational resource');
}
