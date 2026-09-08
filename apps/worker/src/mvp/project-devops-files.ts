import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import {chmod,chown,lstat,mkdir,rename,rm,writeFile} from 'node:fs/promises';

export type DevopsInput=Readonly<{host:string;port:number;user:string;privateKey?:string;cloud:'none'|'yandex';cloudConfig?:string}>;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max&&!value.includes('\0')?value:undefined;
export const parseDevopsInput=(value:Record<string,unknown>):DevopsInput=>{
  const host=text(value.host,253)?.trim();const user=text(value.user,64)?.trim();const port=Number(value.port??22);
  if(!host||(!isIP(host)&&! /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))||
    !user||! /^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$/.test(user)||!Number.isInteger(port)||port<1||port>65535||
    !['none','yandex'].includes(String(value.cloud)))throw new Error('project_devops_invalid');
  const privateKey=text(value.privateKey,32768);const cloudConfig=text(value.cloudConfig,65536);
  if(value.privateKey!==undefined&&privateKey===undefined||value.cloudConfig!==undefined&&cloudConfig===undefined)
    throw new Error('project_devops_invalid');
  if(privateKey&&!/^-----BEGIN (?:(?:OPENSSH|RSA|EC) )?PRIVATE KEY-----/.test(privateKey.trim()))throw new Error('project_devops_key_invalid');
  return {host,port,user,cloud:value.cloud as 'none'|'yandex',...(privateKey?{privateKey}:{}),...(cloudConfig?{cloudConfig}:{})};
};

export const devopsContainerDirectory='/opt/data/devops';
export const renderDevopsSshConfig=(input:Pick<DevopsInput,'host'|'user'|'port'>)=>
  `Host project\n  HostName ${input.host}\n  User ${input.user}\n  Port ${input.port}\n`+
  `  IdentityFile ${devopsContainerDirectory}/id\n  UserKnownHostsFile ${devopsContainerDirectory}/known_hosts\n`+
  '  StrictHostKeyChecking accept-new\n  IdentitiesOnly yes\n  BatchMode yes\n  ConnectTimeout 10\n';

export const writeDevopsFiles=async(root:string,input:DevopsInput,owner={uid:10000,gid:10000})=>{
  const directory=`${root}/data/devops`;await mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
  const existing=await lstat(directory);if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('project_runtime_host_layout_failed');
  await chown(directory,owner.uid,owner.gid);await chmod(directory,0o700);
  const available=async(name:string)=>{const file=await lstat(`${directory}/${name}`).catch(()=>null);
    return file?.isFile()&&!file.isSymbolicLink()&&file.size>0;};
  if(!input.privateKey&&!await available('id'))throw new Error('project_devops_key_required');
  if(input.cloud==='yandex'&&!input.cloudConfig&&!await available('yandex.yaml'))throw new Error('project_devops_cloud_required');
  const write=async(name:string,value:string)=>{const temporary=`${directory}/${name}.${randomUUID()}`;
    try{await writeFile(temporary,value.trimEnd()+'\n',{mode:0o600,flag:'wx'});
      await chown(temporary,owner.uid,owner.gid);await rename(temporary,`${directory}/${name}`);
    }finally{await rm(temporary,{force:true});}};
  if(input.privateKey)await write('id',input.privateKey);
  if(input.cloud==='yandex'){
    if(input.cloudConfig)await write('yandex.yaml',input.cloudConfig);
  }
  await write('ssh_config',renderDevopsSshConfig(input));
};
