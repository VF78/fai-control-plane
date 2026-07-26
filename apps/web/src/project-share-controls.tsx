'use client';

import {useRouter} from 'next/navigation';
import {useState, type FormEvent} from 'react';
import type {AccessData, OperatorProjectSlug} from './operator-data';

type Sharing = AccessData['sharing'];

const localDateTime = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const stamp = (value: Date): string =>
  `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function ProjectShareControls({
  csrfToken,
  enabled,
  grants,
  projects
}: Readonly<{
  csrfToken: string | null;
  enabled: boolean;
  grants: Sharing['grants'];
  projects: Sharing['projects'];
}>) {
  const router = useRouter();
  const [projectSlug, setProjectSlug] = useState<OperatorProjectSlug>(
    projects[0]?.slug ?? 'msa'
  );
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [oneTimeUrl, setOneTimeUrl] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [bounds] = useState(() => {
    const now = new Date();
    return {
      min: localDateTime(new Date(now.getTime() + 60_000)),
      max: localDateTime(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000))
    };
  });
  const project = projects.find(({slug}) => slug === projectSlug);
  const canMutate = enabled && csrfToken !== null;

  const selectProject = (slug: OperatorProjectSlug) => {
    setProjectSlug(slug);
    setSelectedIds([]);
    setMessage(null);
  };

  const toggleItem = (id: string) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : current.length >= 100 ? current : [...current, id]);
  };

  const createShare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canMutate || selectedIds.length === 0 || expiresAt === '') return;
    setPending(true);
    setMessage(null);
    setOneTimeUrl(null);
    setCopyMessage(null);
    try {
      const response = await fetch('/api/project-shares', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          _csrf: csrfToken,
          projectSlug,
          workItemIds: selectedIds,
          expiresAt: new Date(expiresAt).toISOString()
        })
      });
      const payload: unknown = await response.json().catch(() => null);
      if (
        !response.ok ||
        typeof payload !== 'object' ||
        payload === null ||
        !('shareUrl' in payload) ||
        typeof payload.shareUrl !== 'string'
      ) {
        setMessage('Share link was not created.');
        return;
      }
      setOneTimeUrl(payload.shareUrl);
      setSelectedIds([]);
      setExpiresAt('');
      router.refresh();
    } catch {
      setMessage('Share link was not created.');
    } finally {
      setPending(false);
    }
  };

  const revokeShare = async (shareId: string) => {
    if (!canMutate) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/project-shares/${encodeURIComponent(shareId)}/revoke`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({_csrf: csrfToken})
        }
      );
      if (!response.ok) {
        setMessage('Share link was not revoked.');
        return;
      }
      router.refresh();
    } catch {
      setMessage('Share link was not revoked.');
    } finally {
      setPending(false);
    }
  };

  const copyOneTimeUrl = async () => {
    if (oneTimeUrl === null) return;
    try {
      await navigator.clipboard.writeText(oneTimeUrl);
      setCopyMessage('Share URL copied.');
    } catch {
      setCopyMessage('Share URL could not be copied.');
    }
  };

  return <section className="share-manager" aria-labelledby="shares-title">
    <header>
      <p className="eyebrow">Scoped client access</p>
      <h2 id="shares-title">Project share links</h2>
    </header>
    {!enabled ? <p className="muted">Public sharing is unavailable.</p>
      : csrfToken === null ? <p className="muted">An authenticated operator session is required.</p>
      : projects.length === 0 ? <p className="muted">No configured project is available for sharing.</p>
      : <form className="share-form" onSubmit={createShare}>
          <label className="share-field">
            <span>Project</span>
            <select
              disabled={pending}
              onChange={(event) =>
                selectProject(event.target.value as OperatorProjectSlug)}
              value={projectSlug}
            >
              {projects.map((item) =>
                <option key={item.slug} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
          <label className="share-field">
            <span>Expires</span>
            <input
              disabled={pending}
              max={bounds.max}
              min={bounds.min}
              onChange={(event) => setExpiresAt(event.target.value)}
              required
              type="datetime-local"
              value={expiresAt}
            />
          </label>
          <fieldset className="share-task-scope">
            <legend>Shared tasks</legend>
            {project === undefined || project.workItems.length === 0
              ? <p className="muted">No active WorkItems are available.</p>
              : <div className="share-task-list">{project.workItems.map((item) =>
                  <label className="share-task-option" key={item.id}>
                    <input
                      checked={selectedIds.includes(item.id)}
                      disabled={pending ||
                        (selectedIds.length >= 100 &&
                          !selectedIds.includes(item.id))}
                      onChange={() => toggleItem(item.id)}
                      type="checkbox"
                    />
                    <span><strong>{item.title}</strong><small>{item.status.replaceAll('_', ' ')}</small></span>
                  </label>)}</div>}
          </fieldset>
          <div className="share-submit">
            <span>{selectedIds.length} selected</span>
            <button
              disabled={pending || selectedIds.length === 0 || expiresAt === ''}
              type="submit"
            >Create link</button>
          </div>
        </form>}
    {oneTimeUrl === null ? null : <div className="one-time-share">
      <strong>Copy this URL now. It will not be shown again.</strong>
      <input aria-label="One-time project share URL" readOnly value={oneTimeUrl} />
      <button onClick={() => void copyOneTimeUrl()} type="button">Copy</button>
      {copyMessage === null ? null : <p aria-live="polite" className={copyMessage === 'Share URL copied.' ? 'share-copy-message' : 'share-copy-message failed'}>{copyMessage}</p>}
    </div>}
    {message === null ? null : <p aria-live="polite" className="share-message">{message}</p>}
    {grants.length === 0 ? <p className="muted share-empty">No share grants are recorded.</p>
      : <div className="share-grant-list">{grants.map((grant) => {
          return <article className="share-grant-row" key={grant.shareId}>
            <strong>{grant.project}</strong>
            <span>{grant.scopedItemCount} scoped tasks</span>
            <span>Created: {stamp(grant.createdAt)}</span>
            <span>Expires: {stamp(grant.expiresAt)}</span>
            <span>{grant.accessCount} recorded views</span>
            <span className={`state ${grant.active ? 'active' : 'expired'}`}>
              {grant.revokedAt !== null ? 'revoked' : grant.active ? 'active' : 'expired'}
            </span>
            {grant.active && canMutate
              ? <button
                  className="revoke-share"
                  disabled={pending}
                  onClick={() => void revokeShare(grant.shareId)}
                  type="button"
                >Revoke</button>
              : null}
          </article>;
        })}</div>}
  </section>;
}
