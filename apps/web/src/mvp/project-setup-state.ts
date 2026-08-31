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

export const projectActiveDocuments=<T extends Readonly<{kind:string}>>(sources:readonly T[])=>{
  const documents=sources.filter(({kind})=>kind.startsWith('project_document_v1:'));
  const activeFixed=new Map<string,T>();const activeSupplemental:T[]=[];
  for(const document of documents){const category=document.kind.split(':')[1]??'';if(category==='supplemental')activeSupplemental.push(document);else if(!activeFixed.has(category))activeFixed.set(category,document);}
  const activeDocuments=[...activeFixed.values(),...activeSupplemental];const categories=new Set(activeDocuments.map(({kind})=>kind.split(':')[1]??''));
  return {activeDocuments,categories,documentsReady:categories.has('combined')||(categories.has('requirements')&&categories.has('passport'))};
};

export const projectSetupGroups=(item:ProjectSetupInput,documentsReady:boolean,contextCurrent:boolean,trackerBound:boolean)=>{
  const setup=projectSetupState(item,documentsReady,contextCurrent);const states=setup.states;
  const groups=[states[0]===true,trackerBound,states[1]===true,states[5]===true&&states[6]===true,states[2]===true&&states[3]===true&&states[4]===true&&states[7]===true] as const;
  return {setup,groups,complete:groups.filter(Boolean).length};
};
