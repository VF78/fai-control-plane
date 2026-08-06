import {cookies} from 'next/headers';
import {currentOperatorSession} from '../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../src/operator-auth';
import {loadWorkspaceData} from '../src/operator-workspace-data';
import {workspaceRoute, type WorkspaceQuery} from '../src/operator-workspace-route';
import {OperatorLogin} from '../src/operator-login';
import {WorkspaceShell} from '../src/workspace-ui';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage({searchParams}: {searchParams: Promise<WorkspaceQuery>}) {
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const route = workspaceRoute(['dashboard'], await searchParams)!;
  const data = await loadWorkspaceData(route, auth.session?.actorId);
  return <WorkspaceShell route={route} data={{
    ...data,
    csrfToken: auth.session?.csrfToken ?? null,
    operatorActorId: auth.session?.actorId ?? null
  }} />;
}
