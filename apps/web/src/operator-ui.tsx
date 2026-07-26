import Link from 'next/link';
import type {ReactNode} from 'react';
import type {OperatorSession} from './operator-auth';
import {workItemStatuses, type AccessData, type HealthData, type OperatorLoad, type OperatorProjectSlug, type PortfolioData, type ProjectData, type RunsData} from './operator-data';
import {ProjectShareControls} from './project-share-controls';
import {TaskPacketConfirmationControls} from './task-packet-confirmation-controls';

type PageKey = 'portfolio' | 'project' | 'runs' | 'access' | 'health';

const navigation = (scope?: OperatorProjectSlug | undefined) => [
  {key: 'portfolio' as const, label: 'Portfolio', href: '/'},
  {key: 'project' as const, label: 'Project Control Panel', href: `/projects/${scope ?? 'msa'}`},
  {key: 'runs' as const, label: 'Runs & Approvals', href: scope === undefined ? '/runs' : `/runs?project=${scope}`},
  {key: 'access' as const, label: 'Access & Policies', href: '/access'},
  {key: 'health' as const, label: 'Health & Audit', href: scope === undefined ? '/health' : `/health?project=${scope}`}
];

export function OperatorShell({active, scope, session, children}: Readonly<{
  active: PageKey;
  scope?: OperatorProjectSlug | undefined;
  session: OperatorSession | null;
  children?: ReactNode | undefined;
}>) {
  return <main className="shell">
    <aside className="sidebar">
      <Link className="product-name" href="/">f(AI) Studio</Link>
      <nav aria-label="Control plane">{navigation(scope).map((item) => (
        <Link aria-current={item.key === active ? 'page' : undefined} className={item.key === active ? 'nav-item active' : 'nav-item'} href={item.href} key={item.key}>{item.label}</Link>
      ))}</nav>
      <div className="project-links" aria-label="Project scope">
        <p className="eyebrow">Projects</p>
        <Link aria-current={scope === 'msa' ? 'page' : undefined} href="/projects/msa">MSA</Link>
        <Link aria-current={scope === 'ascon' ? 'page' : undefined} href="/projects/ascon">ASCON</Link>
      </div>
    </aside>
    <section className="content">
      {session === null ? <p className="source">PostgreSQL canonical state</p> : <OperatorIdentity session={session} />}
      {children}
    </section>
  </main>;
}

export function OperatorLogin() {
  return <main className="login-shell"><section className="login-panel" aria-labelledby="login-title">
    <p className="product-name">f(AI) Studio</p><p className="eyebrow">Operator access</p><h1 id="login-title">Control Plane</h1>
    <p>Sign in with an authorized GitHub operator account.</p><a className="login-action" href="/api/auth/github/login">Continue with GitHub</a>
  </section></main>;
}

function OperatorIdentity({session}: {session: OperatorSession}) {
  return <div className="operator-identity"><span>{session.displayName}</span><form action="/api/auth/logout" method="post">
    <input name="_csrf" type="hidden" value={session.csrfToken} /><button type="submit">Sign out</button>
  </form></div>;
}

export function PageHeader({eyebrow, title, detail}: Readonly<{eyebrow: string; title: string; detail?: string}>) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{detail === undefined ? null : <p className="source">{detail}</p>}</header>;
}

export function LoadState<T>({load, children}: Readonly<{load: OperatorLoad<T>; children: (data: T) => ReactNode}>) {
  if (load.state === 'ready') return <>{children(load.data)}</>;
  return load.state === 'unconfigured'
    ? <State title="Database is not configured">Set <code>DATABASE_URL</code> to load the operator workspace.</State>
    : <State title="Canonical data is unavailable">The operator view did not receive a usable PostgreSQL response. No status is inferred.</State>;
}

export function State({title, children}: Readonly<{title: string; children: ReactNode}>) {
  return <section className="empty-state" aria-live="polite"><h2>{title}</h2><p>{children}</p></section>;
}

const stamp = (value: Date | null): string => value === null ? 'No recorded time' : `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const age = (value: Date | null): 'fresh' | 'stale' | 'unknown' => {
  if (value === null) return 'unknown';
  return Date.now() - value.getTime() > 24 * 60 * 60 * 1000 ? 'stale' : 'fresh';
};
const label = (value: string): string => value.replaceAll('_', ' ');

export function PortfolioView({data}: {data: PortfolioData}) {
  return <div className="control-surface">
    <section className="portfolio-projects" aria-labelledby="portfolio-projects-title"><header><p className="eyebrow">Configured scope</p><h2 id="portfolio-projects-title">Projects</h2></header>
      {data.projects.length === 0 ? <p className="muted">No MSA or ASCON project is recorded in canonical state.</p> : <div className="project-summary-list">{data.projects.map((project) => <article className="project-summary" key={project.id}>
        <div><Link href={`/projects/${project.slug}`}><strong>{project.name}</strong></Link><span>{project.unresolvedRiskCount} unresolved risk signals</span></div>
        <span className={`state ${project.health}`}>Recorded health: {project.health}</span><span className={`state ${age(project.synchronizedAt)}`}>Tracker: {stamp(project.synchronizedAt)}</span><span>Snapshot: {stamp(project.snapshotAt)}</span>
      </article>)}</div>}
    </section>
    <AttentionQueue items={data.attention} />
  </div>;
}

function AttentionQueue({items}: {items: readonly PortfolioData['attention'][number][]}) {
  return <section className="attention" aria-labelledby="attention-title"><header><p className="eyebrow">Ranked exceptions</p><h2 id="attention-title">Attention Queue</h2></header>
    {items.length === 0 ? <p className="muted">No unresolved exceptions in the MSA and ASCON scope.</p> : <div className="attention-list">{items.map((item) => <article className="attention-row" key={item.id}>
      <span className={`severity ${item.severity}`}>{item.severity}</span><div><strong>{item.object}</strong><span>{item.project}</span></div><div><strong>{item.reason}</strong><span>{item.impact}</span></div>
      <div><span>{item.evidence}</span><time dateTime={item.freshness.toISOString()}>{stamp(item.freshness)}</time></div><span>{item.owner ?? 'No recorded owner'}</span>
      {item.action.href === null ? <span className="no-link">{item.action.label}</span> : <a href={item.action.href} rel="noreferrer" target="_blank">{item.action.label}</a>}
    </article>)}</div>}
  </section>;
}

export function ProjectView({data}: {data: ProjectData}) {
  return <div className="control-surface">
    <section className="project-facts" aria-labelledby="project-facts-title"><header><p className="eyebrow">Selected project</p><h2 id="project-facts-title">{data.project.name}</h2></header>
      <dl className="fact-grid"><div><dt>Default branch</dt><dd>{data.project.defaultBranch}</dd></div><div><dt>Project record</dt><dd>{stamp(data.project.updatedAt)}</dd></div><div><dt>Tracker operation</dt><dd className={age(data.synchronizedAt)}>{stamp(data.synchronizedAt)}</dd></div><div><dt>Latest snapshot</dt><dd>{data.snapshot === null ? 'No recorded snapshot' : `${data.snapshot.health}, ${stamp(data.snapshot.capturedAt)}`}</dd></div></dl>
      {data.project.description === null ? null : <p className="project-description">{data.project.description}</p>}
    </section>
    <section className="work-ledger" aria-labelledby="work-title"><header><p className="eyebrow">Canonical work</p><h2 id="work-title">WorkItems by status</h2></header>
      {workItemStatuses.map((status) => { const items = data.workItems.filter((item) => item.status === status); return <section className="status-group" key={status}><h3>{label(status)} <span>{items.length}</span></h3>
        {items.length === 0 ? <p className="status-empty">No recorded WorkItems.</p> : <div className="work-list">{items.map((item) => <article className="work-row" key={item.id}>
          <div><strong>{item.title}</strong>{item.summary === null ? null : <span>{item.summary}</span>}</div><span>{item.owner ?? 'No recorded owner'}</span><span className={item.blocked ? 'blocked yes' : 'blocked'}>{item.blocked ? 'Blocked' : 'Not blocked'}</span><time dateTime={item.updatedAt.toISOString()}>{stamp(item.updatedAt)}</time>
          {item.externalUrl === null ? <span className="no-link">No source link</span> : <a href={item.externalUrl} rel="noreferrer" target="_blank">Open source</a>}
        </article>)}</div>}</section>; })}
    </section>
  </div>;
}

export function RunsView({data, csrfToken, operatorActorId}: {
  data: RunsData;
  csrfToken: string | null;
  operatorActorId: string | null;
}) {
  return <div className="control-surface">
    <section className="packet-ledger" aria-labelledby="packets-title"><header><p className="eyebrow">Immutable task packets</p><h2 id="packets-title">Packet preview and confirmation</h2></header>
      {data.packets.length === 0 ? <p className="muted">No persisted unqueued task packets are recorded in this scope.</p> : <div className="packet-list">{data.packets.map((packet) => <article className="packet-preview" key={packet.id}>
        <header><div><strong>{packet.workItemTitle}</strong><span>{packet.project} · Frozen task version {packet.frozenWorkItemVersion} · Current task version {packet.currentWorkItemVersion}</span></div><span className={`state ${packet.runnable ? 'active' : 'failed'}`}>{packet.runnable ? 'runnable' : 'not runnable'}</span></header>
        <p className="packet-goal">{packet.goal}</p>
        <dl className="packet-facts"><div><dt>Content hash</dt><dd><code>{packet.contentHash}</code></dd></div><div><dt>Timebox</dt><dd>{packet.timeboxMinutes} minutes</dd></div><div><dt>Runtime</dt><dd>{packet.runtimeProfile}</dd></div><div><dt>Auth mode</dt><dd>{packet.authMode}</dd></div><div><dt>Reviewer</dt><dd>{packet.reviewer}</dd></div><div><dt>Approver</dt><dd>{packet.approver}</dd></div></dl>
        <div className="packet-sections"><section><h3>Acceptance</h3><ul>{packet.acceptanceCriteria.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>In scope</h3><ul>{packet.inScope.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Out of scope</h3><ul>{packet.outOfScope.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Links</h3><ul>{packet.relevantLinks.length === 0 ? <li>No recorded links</li> : packet.relevantLinks.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Relevant files</h3><ul>{packet.relevantFiles.length === 0 ? <li>No recorded files</li> : packet.relevantFiles.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Allowed tools</h3><ul>{packet.allowedTools.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Forbidden surfaces</h3><ul>{packet.forbiddenSurfaces.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Data policy</h3><pre>{JSON.stringify(packet.dataPolicy, null, 2)}</pre></section><section><h3>Expected output</h3><pre>{JSON.stringify(packet.expectedOutputSchema, null, 2)}</pre></section></div>
        {operatorActorId !== packet.approverActorId ? <p className="packet-state">Only the recorded packet approver can confirm this packet.</p> : <TaskPacketConfirmationControls packet={packet} csrfToken={csrfToken} enabled={operatorActorId !== null} />}
      </article>)}</div>}
    </section>
    <section className="runs-ledger" aria-labelledby="runs-title"><header><p className="eyebrow">Persisted execution</p><h2 id="runs-title">Runs</h2></header>
      {data.runs.length === 0 ? <p className="muted">No persisted runs in this scope.</p> : <div className="run-list">{data.runs.map((run) => <article className="run-row" key={run.id}>
        <div><strong>{run.workItem ?? 'No recorded WorkItem title'}</strong><span>{run.project} · {run.runtimeProfile} · {run.timeboxMinutes} min packet</span></div><span className={`state ${run.status}`}>{label(run.status)}</span>
        <div><span>Started: {stamp(run.startedAt)}</span><span>Completed: {stamp(run.completedAt)}</span><span>Heartbeat: {stamp(run.heartbeatAt)}</span></div><div><span>{run.receipt === null ? 'No receipt recorded' : `Receipt: ${run.receipt.terminal}, ${stamp(run.receipt.completedAt)}`}</span><span>{run.artifacts.length === 0 ? 'No artifacts recorded' : `${run.artifacts.length} recorded artifacts`}</span>{run.failureCode === null ? null : <span>Failure code: {run.failureCode}</span>}</div><p>{run.packetGoal}</p>
      </article>)}</div>}
    </section>
    <section className="approvals-ledger" aria-labelledby="approvals-title"><header><p className="eyebrow">Persisted policy records</p><h2 id="approvals-title">Approvals</h2></header>
      {data.approvals.length === 0 ? <p className="muted">No persisted approvals in this scope.</p> : <div className="table-list">{data.approvals.map((approval) => <article className="table-row" key={approval.id}>
        <strong>{approval.project}</strong><span>{label(approval.actionCategory)} · {label(approval.surface)} · {approval.environment}</span><span className={`state ${approval.status}`}>{approval.status}</span><span>Policy v{approval.policyVersion}</span><span>Expires: {stamp(approval.expiresAt)}</span><span>Decided: {stamp(approval.decidedAt)}</span>
      </article>)}</div>}
    </section>
  </div>;
}

export function AccessView({csrfToken, data, policyVersion}: {
  csrfToken: string | null;
  data: AccessData;
  policyVersion: number;
}) {
  return <div className="control-surface">
    <ProjectShareControls
      csrfToken={csrfToken}
      enabled={data.sharing.enabled}
      grants={data.sharing.grants}
      projects={data.sharing.projects}
    />
    <section aria-labelledby="actors-title"><header><p className="eyebrow">Persisted identities</p><h2 id="actors-title">Actors</h2></header>{data.actors.length === 0 ? <p className="muted">No actors are recorded in the configured workspace.</p> : <div className="table-list">{data.actors.map((actor) => <article className="table-row" key={actor.id}><strong>{actor.displayName}</strong><span>{actor.type} · {label(actor.role)}</span><span>{actor.disabledAt === null ? 'Enabled' : `Disabled: ${stamp(actor.disabledAt)}`}</span><span>{Object.keys(actor.capabilities).filter((key) => actor.capabilities[key]).length} recorded capabilities</span></article>)}</div>}</section>
    <section aria-labelledby="requests-title"><header><p className="eyebrow">Persisted access requests</p><h2 id="requests-title">Requests</h2></header>{data.requests.length === 0 ? <p className="muted">No access requests are recorded.</p> : <div className="table-list">{data.requests.map((request) => <article className="table-row" key={request.id}><strong>{request.requester}</strong><span>{label(request.targetSurface)}</span><span>{request.requestedScope.length === 0 ? 'No recorded scope' : request.requestedScope.join(', ')}</span><span className={`state ${request.status}`}>{request.status}</span><span>Expires: {stamp(request.expiresAt)}</span></article>)}</div>}</section>
    <section aria-labelledby="secrets-title"><header><p className="eyebrow">Persisted metadata</p><h2 id="secrets-title">Secret refs</h2></header>{data.secretRefs.length === 0 ? <p className="muted">No secret references are recorded.</p> : <div className="table-list">{data.secretRefs.map((secretRef) => <article className="table-row" key={secretRef.id}><strong>{secretRef.provider}</strong><span>{secretRef.scope.length === 0 ? 'No recorded scope' : secretRef.scope.join(', ')}</span><span>Rotated: {stamp(secretRef.lastRotatedAt)}</span></article>)}</div>}</section>
    <section aria-labelledby="policy-title"><header><p className="eyebrow">Read-only code policy</p><h2 id="policy-title">Current policy matrix v{policyVersion}</h2></header><div className="table-list">{data.policy.map((row) => <article className="table-row policy-row" key={row.actorType}><strong>{row.actorType}</strong><span>Allow {row.allow}</span><span>Ask {row.ask}</span><span>Deny {row.deny}</span></article>)}</div></section>
  </div>;
}

export function HealthView({data}: {data: HealthData}) {
  return <div className="control-surface">
    <HealthSection title="Scheduled jobs" eyebrow="Persisted scheduler facts" empty="No scheduled jobs are recorded in this scope." items={data.jobs}>{(job) => <article className="table-row" key={job.id}><strong>{job.project} · {job.name}</strong><span className={`state ${job.status}`}>{job.status}</span><span>Heartbeat: {stamp(job.heartbeatAt)}</span><span>Last success: {stamp(job.lastSuccessAt)}</span><span>Next run: {stamp(job.nextRunAt)}</span></article>}</HealthSection>
    <HealthSection title="Integration operations" eyebrow="Persisted tracker facts" empty="No tracker snapshot operations are recorded in this scope." items={data.integrations}>{(integration) => <article className="table-row" key={integration.id}><strong>{integration.project}</strong><span>{integration.provider}</span><span>{integration.mode}</span><span>{stamp(integration.createdAt)}</span></article>}</HealthSection>
    <HealthSection title="Unresolved risks" eyebrow="Persisted risk signals" empty="No unresolved risk signals are recorded in this scope." items={data.risks}>{(risk) => <article className="table-row" key={risk.id}><strong>{risk.project}</strong><span className={`severity ${risk.severity}`}>{risk.severity}</span><span>{risk.summary}</span><span>{stamp(risk.updatedAt)}</span></article>}</HealthSection>
    <HealthSection title="Audit facts" eyebrow="Recent canonical audit events" empty="No audit events are recorded in this scope." items={data.audit}>{(event) => <article className="table-row" key={event.id}><strong>{event.project}</strong><span>{event.action}</span><span>{event.outcome ?? 'No recorded outcome'}</span><span>{event.reasonCode ?? 'No recorded reason code'}</span><span>{stamp(event.occurredAt)}</span></article>}</HealthSection>
  </div>;
}

function HealthSection<T>({title, eyebrow, empty, items, children}: Readonly<{title: string; eyebrow: string; empty: string; items: readonly T[]; children: (item: T) => ReactNode}>) {
  return <section aria-label={title}><header><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></header>{items.length === 0 ? <p className="muted">{empty}</p> : <div className="table-list">{items.map(children)}</div>}</section>;
}
