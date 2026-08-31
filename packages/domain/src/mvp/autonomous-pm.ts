import type {AutonomousPmRequest,AutonomousPmResult} from './ports.ts';
import {isBoundedId,isHttpsUrl} from './model.ts';

const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&
  value.length<=max&&!value.includes('\0');

export const validateAutonomousPmRequest=(value:AutonomousPmRequest):boolean=>
  value.contract==='fai.autonomous-pm-request.v1'&&isBoundedId(value.project.id)&&
  isHttpsUrl(value.project.repositoryUrl)&&isHttpsUrl(value.project.trackerUrl)&&
  /^[a-f0-9]{64}$/.test(value.versions.process)&&/^[a-f0-9]{64}$/.test(value.versions.routing)&&
  isBoundedId(value.correlationId)&&isBoundedId(value.idempotencyKey);

export const renderAutonomousPmRequest=(value:AutonomousPmRequest):string=>JSON.stringify(value);

export const parseAutonomousPmResult=(output:unknown):AutonomousPmResult|null=>{
  if(!bounded(output,8_192))return null;
  const normalized=output.startsWith('```json\n')&&output.endsWith('\n```')?output.slice(8,-4):output;
  let value:unknown;try{value=JSON.parse(normalized);}catch{return null;}
  if(value===null||typeof value!=='object'||Array.isArray(value))return null;
  const record=value as Record<string,unknown>;
  if(record.contract!=='fai.autonomous-pm-result.v1'||
    !['no-eligible','blocker','selected'].includes(String(record.outcome))||!bounded(record.reason,4_000))return null;
  if(record.outcome!=='selected')return record.selection===undefined?{
    contract:'fai.autonomous-pm-result.v1',outcome:record.outcome as 'no-eligible'|'blocker',reason:record.reason}:null;
  if(record.selection===null||typeof record.selection!=='object'||Array.isArray(record.selection))return null;
  const selection=record.selection as Record<string,unknown>;
  if(!isBoundedId(selection.itemId)||!isHttpsUrl(selection.issueUrl)||!isBoundedId(selection.observedVersion))return null;
  return {contract:'fai.autonomous-pm-result.v1',outcome:'selected',reason:record.reason,
    selection:{itemId:selection.itemId,issueUrl:selection.issueUrl,observedVersion:selection.observedVersion}};
};
