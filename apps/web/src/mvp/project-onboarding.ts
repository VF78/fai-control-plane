import {registerProject,type Database} from '@fai-control-plane/db';
import type {OpaqueSecretRef} from '@fai-control-plane/domain';
import {secretResolver} from './runtime.ts';

const githubUrls=(projectValue:string,repositoryValue:string)=>{
  const projectUrl=new URL(projectValue);const repositoryUrl=new URL(repositoryValue);
  const project=/^\/users\/([^/]+)\/projects\/(\d+)\/?$/.exec(projectUrl.pathname);
  const repository=/^\/([^/]+)\/([^/]+)\/?$/.exec(repositoryUrl.pathname);
  if(projectUrl.origin!=='https://github.com'||repositoryUrl.origin!=='https://github.com'||project===null||
    repository===null||project[1]!.toLowerCase()!==repository[1]!.toLowerCase())throw new Error('github_binding_invalid');
  return {projectUrl:projectUrl.toString().replace(/\/$/,''),repositoryUrl:repositoryUrl.toString().replace(/\/$/,''),
    owner:project[1]!,projectNumber:Number(project[2]),repository:repository[2]!};
};
const githubTokenRef=():OpaqueSecretRef=>({id:'GITHUB_PROJECTS_TOKEN',purpose:'tracker_read',
  locator:process.env.GITHUB_PROJECTS_TOKEN_FILE??''});
const githubRequest=async(url:string,token:string,init?:RequestInit)=>{const response=await fetch(url,{...init,headers:{
  accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28',
  ...(init?.headers??{})},signal:AbortSignal.timeout(15_000)});if(!response.ok)throw new Error('github_read_failed');return response;};

export const resolveAndRegisterProject=async(database:Database,input:Readonly<{workspaceId:string;actorId:string;
  name:string;slug:string;projectUrl:string;repositoryUrl:string;idempotencyKey:string}>)=>{
  const urls=githubUrls(input.projectUrl,input.repositoryUrl);
  const token=(await secretResolver.resolve(githubTokenRef(),'tracker_read')).value;
  const query=`query($owner:String!,$number:Int!,$repository:String!){
    user(login:$owner){projectV2(number:$number){id}} repository(owner:$owner,name:$repository){id defaultBranchRef{name}}}`;
  const graph=await githubRequest('https://api.github.com/graphql',token,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({query,variables:{owner:urls.owner,number:urls.projectNumber,repository:urls.repository}})});
  const payload=await graph.json() as {data?:{user?:{projectV2?:{id?:string}},repository?:{id?:string;defaultBranchRef?:{name?:string}}}};
  const externalProjectId=payload.data?.user?.projectV2?.id;const repositoryId=payload.data?.repository?.id;
  const defaultBranch=payload.data?.repository?.defaultBranchRef?.name;
  if(typeof externalProjectId!=='string'||typeof repositoryId!=='string'||typeof defaultBranch!=='string'||
    !/^[^\0\r\n]{1,256}$/.test(defaultBranch))throw new Error('github_binding_invalid');
  return registerProject(database,{...input,name:input.name.trim(),slug:input.slug.trim(),projectUrl:urls.projectUrl,
    repositoryUrl:urls.repositoryUrl,externalProjectId,repositoryId});
};
