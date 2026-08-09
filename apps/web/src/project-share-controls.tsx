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
  projects,
  project: fixedProject
}: Readonly<{
  csrfToken: string | null;
  enabled: boolean;
  grants: Sharing['grants'];
  projects: Sharing['projects'];
  /** Project surfaces must not select or revoke a share in another project. */
  project?: Sharing['projects'][number] | undefined;
}>) {
  const router = useRouter();
  const availableProjects = fixedProject === undefined ? projects : [fixedProject];
  const [projectSlug, setProjectSlug] = useState<OperatorProjectSlug>(
    availableProjects[0]?.slug ?? 'msa'
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
  const project = fixedProject ?? availableProjects.find(({slug}) => slug === projectSlug);
  const visibleGrants = fixedProject === undefined
    ? grants
    : grants.filter((grant) => grant.projectSlug === fixedProject.slug);
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
          projectSlug: project?.slug ?? projectSlug,
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
        setMessage('Не удалось создать ссылку.');
        return;
      }
      setOneTimeUrl(payload.shareUrl);
      setSelectedIds([]);
      setExpiresAt('');
      router.refresh();
    } catch {
      setMessage('Не удалось создать ссылку.');
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
        setMessage('Не удалось отозвать ссылку.');
        return;
      }
      router.refresh();
    } catch {
      setMessage('Не удалось отозвать ссылку.');
    } finally {
      setPending(false);
    }
  };

  const copyOneTimeUrl = async () => {
    if (oneTimeUrl === null) return;
    try {
      await navigator.clipboard.writeText(oneTimeUrl);
      setCopyMessage('Ссылка скопирована.');
    } catch {
      setCopyMessage('Не удалось скопировать ссылку.');
    }
  };

  return <section className="share-manager" aria-labelledby="shares-title">
    <header>
      <p className="eyebrow">Временный доступ клиента</p>
      <h2 id="shares-title">Ссылки на задачи проекта</h2>
    </header>
    {!enabled ? <p className="muted">Внешний доступ отключён.</p>
      : csrfToken === null ? <p className="muted">Нужна авторизованная сессия оператора.</p>
      : availableProjects.length === 0 ? <p className="muted">Нет проекта, которым можно поделиться.</p>
      : <form className="share-form" onSubmit={createShare}>
          {fixedProject === undefined ? <label className="share-field">
            <span>Проект</span>
            <select
              disabled={pending}
              onChange={(event) =>
                selectProject(event.target.value as OperatorProjectSlug)}
              value={projectSlug}
            >
              {availableProjects.map((item) =>
                <option key={item.slug} value={item.slug}>{item.name}</option>)}
            </select>
          </label> : <p className="share-project-scope">Ссылка ограничена проектом {fixedProject.name}.</p>}
          <label className="share-field">
            <span>Действует до</span>
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
            <legend>Доступные задачи</legend>
            {project === undefined || project.workItems.length === 0
              ? <p className="muted">Активных задач для публичного доступа нет.</p>
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
            <span>Выбрано: {selectedIds.length}</span>
            <button
              disabled={pending || selectedIds.length === 0 || expiresAt === ''}
              type="submit"
            >Создать ссылку</button>
          </div>
        </form>}
    {oneTimeUrl === null ? null : <div className="one-time-share">
      <strong>Скопируйте ссылку сейчас: повторно она не будет показана.</strong>
      <input aria-label="Одноразовая ссылка на проект" readOnly value={oneTimeUrl} />
      <button onClick={() => void copyOneTimeUrl()} type="button">Скопировать</button>
      {copyMessage === null ? null : <p aria-live="polite" className={copyMessage === 'Ссылка скопирована.' ? 'share-copy-message' : 'share-copy-message failed'}>{copyMessage}</p>}
    </div>}
    {message === null ? null : <p aria-live="polite" className="share-message">{message}</p>}
    {visibleGrants.length === 0 ? <p className="muted share-empty">Действующие ссылки не зафиксированы.</p>
      : <div className="share-grant-list">{visibleGrants.map((grant) => {
          return <article className="share-grant-row" key={grant.shareId}>
            <strong>{fixedProject === undefined ? grant.project : 'Ссылка для клиента'}</strong>
            <span>Задач: {grant.scopedItemCount}</span>
            <span>Создана: {stamp(grant.createdAt)}</span>
            <span>Истекает: {stamp(grant.expiresAt)}</span>
            <span>Просмотров: {grant.accessCount}</span>
            <span className={`state ${grant.active ? 'active' : 'expired'}`}>
              {grant.revokedAt !== null ? 'Отозвана' : grant.active ? 'Активна' : 'Истекла'}
            </span>
            {grant.active && canMutate
              ? <button
                  className="revoke-share"
                  disabled={pending}
                  onClick={() => void revokeShare(grant.shareId)}
                  type="button"
                >Отозвать</button>
              : null}
          </article>;
        })}</div>}
  </section>;
}
