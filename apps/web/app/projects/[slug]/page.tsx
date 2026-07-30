import {notFound, redirect} from 'next/navigation';
import {isOperatorProjectSlug} from '../../../src/operator-data';
import type {WorkspaceQuery} from '../../../src/operator-workspace-route';

export const dynamic = 'force-dynamic';

export default async function ProjectControlPanelPage({params, searchParams}: {
  params: Promise<{slug: string}>;
  searchParams: Promise<WorkspaceQuery>;
}) {
  const {slug} = await params;
  if (!isOperatorProjectSlug(slug)) notFound();
  const query = await searchParams;
  const search = new URLSearchParams();
  for (const key of ['environment', 'from', 'to'] as const) {
    if (typeof query[key] === 'string') search.set(key, query[key]);
  }
  const suffix = search.toString();
  redirect(`/projects/${slug}/overview${suffix === '' ? '' : `?${suffix}`}`);
}
