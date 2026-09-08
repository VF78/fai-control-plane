'use client';

import {useState,type FormEvent} from 'react';
import type {ProjectDevopsAccess} from '@fai-control-plane/db';
import {AsyncButton,CommandNoticeView,useAsyncCommand} from './async-command.tsx';
import {InlineAlert,ReadOnlyNotice} from '../ui/foundation.tsx';

const errors:Record<string,string>={
  project_devops_invalid:'Проверьте адрес сервера, пользователя и порт.',
  project_devops_key_invalid:'Нужен приватный SSH-ключ в формате OpenSSH или PEM.',
  project_devops_key_required:'Добавьте приватный SSH-ключ для первого подключения.',
  project_devops_cloud_required:'Добавьте конфигурацию облачного CLI.',
  project_runtime_unavailable:'Сначала подключите ИИ-агента проекта.',
  project_runtime_denied:'Настройка доступна владельцу проекта.',
};

/** Same editor in setup and project settings; credentials are never returned by the API. */
export function ProjectDevopsAccessEditor({projectId,value,canManage}:Readonly<{
  projectId:string;value:ProjectDevopsAccess|null|undefined;canManage:boolean;
}>){
  const command=useAsyncCommand();const [cloud,setCloud]=useState(value?.cloud??'none');
  const [checked,setChecked]=useState(value);const [privateKey,setPrivateKey]=useState('');const [cloudConfig,setCloudConfig]=useState('');
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);
    void command.run(async()=>{const response=await fetch(`/api/projects/${projectId}/runtime`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({action:'configure_devops',
        host:form.get('host'),user:form.get('user'),port:Number(form.get('port')),cloud,privateKey,cloudConfig,
        idempotencyKey:`project-devops:${crypto.randomUUID()}`})});
      const result=await response.json() as {error?:string;devops?:ProjectDevopsAccess};
      if(!response.ok)throw new Error(result.error??'request_failed');
      if(!result.devops)throw new Error('request_failed');
      setChecked(result.devops);setPrivateKey('');setCloudConfig('');
      if(result.devops.ssh!=='configured')throw new Error('SSH-подключение не подтверждено. Проверьте ключ и доступ пользователя к серверу.');
      if(result.devops.cloudStatus==='error')throw new Error('SSH работает. Облачный CLI не подтвердил доступ — проверьте его конфигурацию.');
      return result.devops;
    },{success:'Доступы сохранены и проверены из среды ИИ-агента.',error:(error)=>{
      const code=error instanceof Error?error.message:'request_failed';
      return errors[code]??(code.startsWith('SSH')?code:'Не удалось сохранить и проверить доступы. Повторите попытку.');
    }});
  };
  if(!canManage)return <ReadOnlyNotice/>;
  return <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>
    <p className="fcp-wizard-intro wide">Доступы сохраняются в среде этого ИИ-агента. Репозиторий и таск-трекер используют уже подключённую авторизацию.</p>
    <label>Сервер SSH<input name="host" defaultValue={value?.host??''} placeholder="server.example.com" required disabled={command.pending}/></label>
    <label>Пользователь<input name="user" defaultValue={value?.user??'root'} required disabled={command.pending}/></label>
    <label>Порт<input name="port" type="number" min={1} max={65535} defaultValue={value?.port??22} required disabled={command.pending}/></label>
    <label className="wide">Приватный SSH-ключ<textarea value={privateKey} onChange={event=>setPrivateKey(event.target.value)} rows={3} maxLength={32768} autoComplete="off" spellCheck={false} disabled={command.pending} placeholder={checked?'Ключ сохранён. Оставьте пустым, чтобы не менять.':'Вставьте приватный ключ OpenSSH или PEM'}/></label>
    <label className="fcp-confirm wide"><input type="checkbox" checked={cloud==='yandex'} onChange={event=>setCloud(event.target.checked?'yandex':'none')} disabled={command.pending}/> Подключить Yandex Cloud — необязательно</label>
    {cloud==='yandex'?<label className="wide">Конфигурация Yandex CLI<textarea value={cloudConfig} onChange={event=>setCloudConfig(event.target.value)} rows={3} maxLength={65536} autoComplete="off" spellCheck={false} disabled={command.pending} placeholder={checked?.cloud==='yandex'?'Конфигурация сохранена. Оставьте пустым, чтобы не менять.':'Вставьте содержимое файла конфигурации yc'}/></label>:null}
    <p className="fcp-wizard-note wide">При первом SSH-подключении ключ сервера запоминается автоматически. Команды развёртывания при проверке не выполняются.</p>
    {checked?.ssh==='error'||checked?.cloudStatus==='error'?<InlineAlert>Настройки сохранены, но не все доступы подтверждены.</InlineAlert>:null}
    <AsyncButton pending={command.pending} pendingLabel="Проверяем доступы…">Сохранить и проверить</AsyncButton>
    <CommandNoticeView notice={command.notice}/>
  </form>;
}
