type ProjectSetupInput=Readonly<{
  evidence:Readonly<{people:readonly Readonly<{active:boolean}>[]}>|null;
  runtimeSetup:Readonly<{telegramConfigured:boolean;status:string}>|null;
  trackerPreparation:Readonly<{status:string}>|null;
  wizardProgress:Readonly<{processConfirmed:boolean;teamSkipped:boolean;communicationsSkipped:boolean}>|null;
}>;

export const projectSetupState=(item:ProjectSetupInput,documentsReady:boolean,contextCurrent:boolean)=>{
  const states=[true,documentsReady,item.wizardProgress?.processConfirmed===true,
    (item.evidence?.people.filter((person)=>person.active).length??0)>1||item.wizardProgress?.teamSkipped===true,
    item.runtimeSetup?.telegramConfigured===true||item.wizardProgress?.communicationsSkipped===true,
    item.runtimeSetup?.status==='ready',contextCurrent,item.trackerPreparation?.status==='ready'];
  const pending=states.findIndex((value)=>!value);
  return {states,complete:pending===-1,nextStep:pending===-1?9:pending};
};
