import {redirect} from 'next/navigation';
import type {WorkspaceQuery} from '../../../src/operator-workspace-route';

export const dynamic = 'force-dynamic';

export default async function PrototypeRedirect({params, searchParams}: {
  params: Promise<{path?: string[]}>;
  searchParams: Promise<WorkspaceQuery>;
}) {
  const [{path}, query] = await Promise.all([params, searchParams]);
  const target = path === undefined || path.length === 0 ? '/dashboard' : `/${path.join('/')}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') search.set(key, value);
  }
  const suffix = search.toString();
  redirect(suffix === '' ? target : `${target}?${suffix}`);
}
