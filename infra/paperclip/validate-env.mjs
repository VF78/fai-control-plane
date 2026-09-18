import {readFileSync} from 'node:fs';
// URL parse errors can carry their input; never expose populated environment values.
process.on('uncaughtException',()=>{console.error('Paperclip environment validation failed.');process.exit(1);});
function read(path) {
  const entries=readFileSync(path,'utf8').trim().split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const index=line.indexOf('=');if(index<1)throw Error('invalid env');return [line.slice(0,index),line.slice(index+1)];});
  if(new Set(entries.map(([key])=>key)).size!==entries.length)throw Error('duplicate env key');
  return Object.fromEntries(entries);
}
const [production,bootstrap]=process.argv.slice(2,4).map(read);
const permitted=new Set(Object.keys(read(new URL('./production.env.example',import.meta.url))));
for(const [env,port,url,exposure,disabled] of [[production,'13010','https://app.f-ai.studio','public','true'],[bootstrap,'13110','http://127.0.0.1:13110','private','false']]) {
  if(Object.keys(env).some(key=>!permitted.has(key)))throw Error('unapproved env key');
  for(const [key,value] of Object.entries({NODE_ENV:'production',HOST:'127.0.0.1',PORT:port,SERVE_UI:'true',PAPERCLIP_HOME:'/var/lib/paperclip',PAPERCLIP_CONFIG:'/var/lib/paperclip/instances/default/config.json',PAPERCLIP_DEPLOYMENT_MODE:'authenticated',PAPERCLIP_DEPLOYMENT_EXPOSURE:exposure,PAPERCLIP_AUTH_BASE_URL_MODE:'explicit',PAPERCLIP_PUBLIC_URL:url,PAPERCLIP_AUTH_PUBLIC_BASE_URL:url,PAPERCLIP_AUTH_DISABLE_SIGN_UP:disabled,PAPERCLIP_SECRETS_STRICT_MODE:'true',PAPERCLIP_STORAGE_PROVIDER:'local_disk',PAPERCLIP_STORAGE_LOCAL_DIR:'/var/lib/paperclip/storage',PAPERCLIP_DB_BACKUP_ENABLED:'false'})) if(env[key]!==value)throw Error(`invalid ${key}`);
  const database=new URL(env.DATABASE_URL);
  if(database.protocol!=='postgresql:'||database.hostname!=='127.0.0.1'||database.port!=='15432'||database.pathname!=='/paperclip'||database.username!=='paperclip'||database.password.length<32)throw Error('invalid isolated database');
  for(const key of ['BETTER_AUTH_SECRET','PAPERCLIP_AGENT_JWT_SECRET'])if(!/^[a-f0-9]{64}$/.test(env[key]))throw Error(`invalid ${key}`);
  if(env.PAPERCLIP_ALLOWED_HOSTNAMES!==(exposure==='public'?'app.f-ai.studio':'127.0.0.1,localhost'))throw Error('invalid host allowlist');
}
for(const key of ['DATABASE_URL','BETTER_AUTH_SECRET','PAPERCLIP_AGENT_JWT_SECRET'])if(production[key]!==bootstrap[key])throw Error('bootstrap identity must persist');
if(process.argv[4]&&decodeURIComponent(new URL(production.DATABASE_URL).password)!==readFileSync(process.argv[4],'utf8').trimEnd())throw Error('database credential reference differs');
