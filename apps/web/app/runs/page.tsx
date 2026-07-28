import {cookies} from 'next/headers';
import {isOperatorProjectSlug, loadRunsData, type OperatorProjectSlug} from '../../src/operator-data';
import {currentOperatorSession} from '../../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../../src/operator-auth';
import {LoadState, OperatorLogin, OperatorShell, PageHeader, RunsView, State} from '../../src/operator-ui';

export const dynamic = 'force-dynamic';

const scopeFrom = (value: string | string[] | undefined): OperatorProjectSlug | null | undefined =>
  value === undefined ? undefined : typeof value === 'string' && isOperatorProjectSlug(value) ? value : null;

const handoffFrom = (
  value: string | string[] | undefined
): 'accepted' | 'stale' | 'forbidden' | 'not_found' | 'unavailable' | null =>
  typeof value === 'string' &&
  ['accepted', 'stale', 'forbidden', 'not_found', 'unavailable'].includes(value)
    ? value as 'accepted' | 'stale' | 'forbidden' | 'not_found' | 'unavailable'
    : null;

export default async function RunsPage({searchParams}: {
  searchParams: Promise<{
    project?: string | string[];
    handoff?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const scope = scopeFrom(query.project);
  const handoffResult = handoffFrom(query.handoff);
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  return <OperatorShell active="runs" scope={scope ?? undefined} session={auth.session}>
    <PageHeader eyebrow="Execution ledger" title="Runs & Approvals" detail={scope === undefined ? 'MSA and ASCON canonical scope' : scope === null ? 'Unsupported project scope' : `${scope.toUpperCase()} canonical scope`} />
    {scope === null ? <State title="Project scope is unavailable">Only MSA and ASCON are available in this operator view.</State> : <LoadState load={await loadRunsData(scope)}>{(data) => <RunsView data={data} csrfToken={auth.session?.csrfToken ?? null} handoffResult={handoffResult} operatorActorId={auth.session?.actorId ?? null} />}</LoadState>}
  </OperatorShell>;
}
