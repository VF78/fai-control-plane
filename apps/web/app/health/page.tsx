import {cookies} from 'next/headers';
import {isOperatorProjectSlug, loadHealthData, type OperatorProjectSlug} from '../../src/operator-data';
import {currentOperatorSession} from '../../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../../src/operator-auth';
import {HealthView, LoadState, OperatorLogin, OperatorShell, PageHeader, State} from '../../src/operator-ui';

export const dynamic = 'force-dynamic';

const scopeFrom = (value: string | string[] | undefined): OperatorProjectSlug | null | undefined =>
  value === undefined ? undefined : typeof value === 'string' && isOperatorProjectSlug(value) ? value : null;

export default async function HealthPage({searchParams}: {searchParams: Promise<{project?: string | string[]}>}) {
  const scope = scopeFrom((await searchParams).project);
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  return <OperatorShell active="health" scope={scope ?? undefined} session={auth.session}>
    <PageHeader eyebrow="Operational evidence" title="Health & Audit" detail={scope === undefined ? 'MSA and ASCON canonical scope' : scope === null ? 'Unsupported project scope' : `${scope.toUpperCase()} canonical scope`} />
    {scope === null ? <State title="Project scope is unavailable">Only MSA and ASCON are available in this operator view.</State> : <LoadState load={await loadHealthData(scope)}>{(data) => <HealthView data={data} />}</LoadState>}
  </OperatorShell>;
}
