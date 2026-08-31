import {createHash} from 'node:crypto';
import type {AutonomousPmResult,ProjectProcessPolicy,TrackerSnapshot} from '@fai-control-plane/domain';

export const autonomousPmKey=(input:Readonly<{projectId:string;modeChangedAt:string;
  processVersion:string;routingVersion:string;snapshotVersion:string}>):string=>
  `autonomous.pm:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;

export const autonomousPmEnabled=(mode:Readonly<{mode:'manual'|'autonomous';actorId:string|null;
  changedAt:string|null}>):mode is Readonly<{mode:'autonomous';actorId:string;changedAt:string}>=>
  mode.mode==='autonomous'&&mode.actorId!==null&&mode.changedAt!==null;

export const sameAutonomousActivation=(mode:Readonly<{mode:'manual'|'autonomous';actorId:string|null;
  changedAt:string|null}>,activation:Readonly<{actorId:string;modeChangedAt:string}>):boolean=>
  autonomousPmEnabled(mode)&&mode.actorId===activation.actorId&&mode.changedAt===activation.modeChangedAt;

/** Verifies only Hermes' exact selection. It never searches, ranks or chooses
 * another snapshot item. */
export const verifyAutonomousPmSelection=(input:Readonly<{result:AutonomousPmResult;snapshot:TrackerSnapshot;
  projectId:string;bindingId:string;ownerOptionId:string;doneStatusOptionId:string;
  process:ProjectProcessPolicy}>):Readonly<{itemId:string;role:'manager'|'developer'|'qa'}>|null=>{
  const selected=input.result.selection;
  if(input.result.outcome!=='selected'||selected===undefined||input.snapshot.bindingId!==input.bindingId)return null;
  const item=input.snapshot.items.find((candidate)=>candidate.itemId===selected.itemId);
  if(item===undefined||item.projectId!==input.projectId||item.url!==selected.issueUrl||
    item.version!==selected.observedVersion||item.blocked!==false||item.ownerOptionId!==input.ownerOptionId||
    item.statusOptionId===null||item.statusOptionId===input.doneStatusOptionId)return null;
  const stage=input.process.stages.find((candidate)=>candidate.title===item.statusOptionName);
  return stage?.automation===null||stage===undefined?null:{itemId:item.itemId,role:stage.automation.agentRole};
};
