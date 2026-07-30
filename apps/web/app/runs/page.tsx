import {redirect} from 'next/navigation';
import {isOperatorProjectSlug} from '../../src/operator-data';

export const dynamic = 'force-dynamic';

export default async function RunsPage({searchParams}: {
  searchParams: Promise<{
    project?: string | string[];
    handoff?: string | string[];
    run?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const project = typeof query.project === 'string' && isOperatorProjectSlug(query.project)
    ? query.project
    : null;
  if (project === null) redirect('/dashboard');
  const run = typeof query.run === 'string' && query.run.length > 0 && query.run.length <= 200
    ? query.run
    : null;
  const handoff = typeof query.handoff === 'string' &&
    ['accepted', 'stale', 'forbidden', 'not_found', 'unavailable'].includes(query.handoff)
    ? query.handoff
    : null;
  const destination = run === null
    ? `/projects/${project}/runs`
    : `/projects/${project}/runs/${encodeURIComponent(run)}`;
  redirect(handoff === null ? destination : `${destination}?handoff=${handoff}`);
}
