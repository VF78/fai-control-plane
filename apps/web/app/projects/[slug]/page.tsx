import {notFound} from 'next/navigation';
import {cookies} from 'next/headers';
import {isOperatorProjectSlug, loadProjectData} from '../../../src/operator-data';
import {currentOperatorSession} from '../../../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../../../src/operator-auth';
import {LoadState, OperatorLogin, OperatorShell, PageHeader, ProjectView} from '../../../src/operator-ui';

export const dynamic = 'force-dynamic';

export default async function ProjectControlPanelPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params;
  if (!isOperatorProjectSlug(slug)) notFound();
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const load = await loadProjectData(slug);
  if (load.state === 'ready' && load.data === null) notFound();
  return <OperatorShell active="project" scope={slug} session={auth.session}>
    <PageHeader eyebrow="Project delivery" title="Project Control Panel" detail={`${slug.toUpperCase()} canonical scope`} />
    <LoadState load={load}>{(data) => data === null ? null : <ProjectView data={data} csrfToken={auth.session?.csrfToken ?? null} />}</LoadState>
  </OperatorShell>;
}
