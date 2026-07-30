import {cookies} from 'next/headers';
import {notFound} from 'next/navigation';
import {OPERATOR_SESSION_COOKIE} from '../../src/operator-auth';
import {currentOperatorSession} from '../../src/operator-auth-runtime';
import {loadWorkspaceData} from '../../src/operator-workspace-data';
import {workspaceRoute, type WorkspaceQuery} from '../../src/operator-workspace-route';
import {OperatorLogin} from '../../src/operator-ui';
import {WorkspaceShell} from '../../src/prototype-ui';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage({params, searchParams}: {
  params: Promise<{path: string[]}>;
  searchParams: Promise<WorkspaceQuery>;
}) {
  const [resolvedParams, query] = await Promise.all([params, searchParams]);
  const route = workspaceRoute(resolvedParams.path, query);
  if (route === null) notFound();
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const data = await loadWorkspaceData(route);
  return <WorkspaceShell route={route} data={{...data, csrfToken: auth.session?.csrfToken ?? null}} />;
}
