import {cookies} from 'next/headers';
import {
  POLICY_SIMULATION_EVALUATOR_VERSION,
  currentPolicyHash
} from '@fai-control-plane/domain';
import {CURRENT_POLICY_VERSION, loadAccessData} from '../../src/operator-data';
import {currentOperatorSession} from '../../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../../src/operator-auth';
import {AccessView, LoadState, OperatorLogin, OperatorShell, PageHeader} from '../../src/operator-ui';

export const dynamic = 'force-dynamic';

export default async function AccessPage() {
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const load = await loadAccessData();
  return <OperatorShell active="access" session={auth.session}>
    <PageHeader eyebrow="Authority records" title="Access & Policies" detail="Canonical access and sharing controls" />
    <LoadState load={load}>{(data) => <AccessView
      csrfToken={auth.session?.csrfToken ?? null}
      data={data}
      policyVersion={CURRENT_POLICY_VERSION}
      evaluatorVersion={POLICY_SIMULATION_EVALUATOR_VERSION}
      policyHash={currentPolicyHash()}
    />}</LoadState>
  </OperatorShell>;
}
