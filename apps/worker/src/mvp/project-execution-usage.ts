import {constants} from 'node:fs';
import {open,opendir,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createInterface} from 'node:readline';
import {listExecutionUsageTasks,recordExecutionUsage,type Database,type ExecutionUsage} from '@fai-control-plane/db';
import {nativeEnvelopeType,parseNativeUsage,type NativeExecutionUsage} from './native-execution-usage.ts';

type Runtime=Readonly<{runtimeId:string;workspacePath:string;agentCredentialRef:Readonly<{locator:string}>}>;
type Scope=Readonly<{workspaceId:string;projectId:string;repositoryUrl:string;runtime:Runtime}>;
type Sample=Readonly<{usage:NativeExecutionUsage;cwd:string|null}>;
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

/** The installed native operator uses the existing issue worktree in workspace/items.
 * Require exact native cwd + one repository-scoped tracker issue. Do not infer an attempt,
 * stage or role, or attach sessions by time, title, branch naming or an agent.submit receipt.
 */
export const linkedUsageItem=(cwd:string|null,scope:Scope,tasks:readonly {itemId:string;url:string}[]):string|null=>{
  const matches=new Set<string>();
  for(const task of tasks){
    const prefix=`${scope.repositoryUrl.replace(/\/$/,'')}/issues/`;
    const number=task.url.startsWith(prefix)?task.url.slice(prefix.length):'';
    if(/^[1-9][0-9]*$/.test(number)&&cwd===`${scope.runtime.workspacePath}/items/${number}`)matches.add(task.itemId);
  }
  return matches.size===1?[...matches][0]!:null;
};

/** Fixed bounds on existing native files; no process invocation or new polling mechanism.
 * cwd is used only in memory for linkage. The accepted parser owns counters/context/parent IDs.
 */
export async function* readProjectUsageSamples(root:string,deadline:number):AsyncGenerator<Sample>{
  if(await realpath(root)!==root)return;
  const files:string[]=[];let visited=0;
  const walk=async(directory:string,depth:number):Promise<void>=>{
    const entries=await opendir(directory);
    for await(const entry of entries){
      if(++visited>2000||Date.now()>deadline)return;
      const path=join(directory,entry.name);
      if(entry.isDirectory()&&depth<3)await walk(path,depth+1);
      else if(entry.isFile()&&/^rollout-[A-Za-z0-9_.-]+\.jsonl$/.test(entry.name))files.push(path);
    }
  };
  await walk(root,0);let bytes=0;
  for(const file of files.sort().reverse().slice(0,64)){
    if(Date.now()>deadline)return;
    try{
      if(!(await realpath(file)).startsWith(`${root}/`))continue;
      const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=await handle.stat();bytes+=stat.size;
        if(!stat.isFile()||stat.size===0||stat.size>64*1024*1024||bytes>128*1024*1024)continue;
        const stream=handle.createReadStream({encoding:'utf8',autoClose:false,start:0,end:stat.size-1,
          signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});
        const lines=createInterface({input:stream,crlfDelay:Infinity});
        let cwd:string|null=null;let seen=false;let conflicting=false;
        async function* metadata(){
          for await(const line of lines){
            if(line.length<=4_194_304&&nativeEnvelopeType(line)==='session_meta'){
              try{
                const payload=object(object(JSON.parse(line)).payload);
                const path=typeof payload.cwd==='string'&&/^\/[-A-Za-z0-9_./]{1,511}$/.test(payload.cwd)?payload.cwd:null;
                if(seen&&cwd!==path)conflicting=true;
                cwd=path;seen=true;
              }catch{ /* The parser marks malformed metadata; never retain the raw envelope. */ }
            }
            yield line;
          }
        }
        try{
          const usage=await parseNativeUsage(metadata());
          if(usage.sessionReference!==null)yield {usage,cwd:conflicting?null:cwd};
        }finally{lines.close();stream.destroy();}
      }finally{await handle.close();}
    }catch{ /* A vanished, unreadable or malformed session is unknown, not zero. */ }
  }
}

/** Runs after ordinary observation, including projects with no local submission receipts.
 * Fixed file/time bounds + bounded SQL; all optional failures stay outside task processing.
 */
export const captureProjectExecutionUsage=async(database:Database,scope:Scope,ports={
  tasks:listExecutionUsageTasks,record:recordExecutionUsage,samples:readProjectUsageSamples
}):Promise<void>=>{
  try{
    const {runtime}=scope;const root=dirname(dirname(runtime.agentCredentialRef.locator));
    if(!/^[a-z0-9-]+$/.test(runtime.runtimeId)||runtime.workspacePath!==`/opt/data/work/${runtime.runtimeId}`||
      root==='/'||!root.startsWith('/')||root.includes('..'))return;
    const deadline=Date.now()+3000;
    // A tracker read failure must still allow project/session-level capture.
    const tasks=await ports.tasks(database,scope).catch(()=>[]);
    for await(const sample of ports.samples(`${root}/codex-home/sessions`,deadline)){
      if(Date.now()>deadline)return;
      const itemId=linkedUsageItem(sample.cwd,scope,tasks);
      const observation:ExecutionUsage={provider:'codex-cli',sessionReference:sample.usage.sessionReference!,
        parentSessionReference:sample.usage.parentSessionReference,itemId,contexts:sample.usage.contexts,
        totals:sample.usage.totals,completeness:sample.usage.completeness,
        reasons:[...sample.usage.reasons,...(itemId===null?['task-unattributed']:[])],
        aggregation:'unknown',provenance:'native-session-metadata'};
      try{
        const status=await ports.record(database,scope,observation);
        if(status==='unavailable')return;
        if(status==='denied'&&itemId!==null)await ports.record(database,scope,{...observation,itemId:null,
          reasons:[...sample.usage.reasons,'task-unattributed']});
      }catch{ /* Optional persistence cannot fail observation or task recovery. */ }
    }
  }catch{ /* Runtime files and provider availability cannot establish task success/failure. */ }
};
