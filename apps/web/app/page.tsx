import {cookies} from 'next/headers';
import {loadPortfolioData} from '../src/operator-data';
import {currentOperatorSession} from '../src/operator-auth-runtime';
import {OPERATOR_SESSION_COOKIE} from '../src/operator-auth';
import {LoadState, OperatorLogin, OperatorShell, PageHeader, PortfolioView} from '../src/operator-ui';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const cookieStore = await cookies();
  const auth = await currentOperatorSession(cookieStore.get(OPERATOR_SESSION_COOKIE)?.value);
  if (auth.enabled && auth.session === null) return <OperatorLogin />;
  const load = await loadPortfolioData();
  return <OperatorShell active="portfolio" session={auth.session}>
    <PageHeader eyebrow="Workspace overview" title="Portfolio" detail="MSA and ASCON canonical scope" />
    <LoadState load={load}>{(data) => <PortfolioView data={data} />}</LoadState>
  </OperatorShell>;
}
