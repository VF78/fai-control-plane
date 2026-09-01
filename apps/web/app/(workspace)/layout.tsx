import type {ReactNode} from 'react';
import {readWorkspace} from '../../src/mvp/workspace-data.ts';
import {Shell} from '../../src/mvp/workspace-shell.tsx';
import {ErrorState,PageHeader} from '../../src/ui/foundation.tsx';

export const dynamic='force-dynamic';

export default async function WorkspaceLayout({children}:Readonly<{children:ReactNode}>){
  const workspace=await readWorkspace();
  if(workspace.session===null)return <main className="fcp-login"><section><span className="fcp-eyebrow">f(AI) Control</span><h1>Вход оператора</h1><p>Авторизация выполняется через GitHub.</p><a className="fcp-primary" href="/api/auth/github/login">Войти через GitHub</a></section></main>;
  if(workspace.projects===null)return <Shell projectCount={0} operatorName={workspace.session.displayName}><PageHeader title="Рабочее пространство"/><ErrorState detail="Данные пока не подтверждены. Сохранённые настройки не изменены; обновите страницу и повторите." action={<a className="fcp-secondary" href="">Повторить</a>}/></Shell>;
  return <Shell projectCount={workspace.projects.length} operatorName={workspace.session.displayName}>{children}</Shell>;
}
