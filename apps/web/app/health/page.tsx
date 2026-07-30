import {redirect} from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function HealthPage({searchParams}: {searchParams: Promise<{project?: string | string[]}>}) {
  const {project} = await searchParams;
  const query = typeof project === 'string' ? `?project=${encodeURIComponent(project)}` : '';
  redirect(`/agents${query}`);
}
