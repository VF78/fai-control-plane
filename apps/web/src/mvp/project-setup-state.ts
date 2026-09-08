type ProjectSetupInput=Readonly<{
  evidence:Readonly<{people:readonly Readonly<{active:boolean}>[]}>|null;
  runtimeSetup:Readonly<{telegramConfigured:boolean;status:string;devops?:Readonly<{ssh:string;cloudStatus:string}>|null}>|null;
  config?:Readonly<{channels:Readonly<{internal:Readonly<{configured:boolean}>}>}>;
  trackerPreparation:Readonly<{status:string}>|null;
  wizardProgress:Readonly<{processConfirmed:boolean;teamSkipped:boolean;communicationsSkipped:boolean}>|null;
}>;

export const projectSetupState=(item:ProjectSetupInput,documentsReady:boolean,contextCurrent:boolean)=>{
  const states=[true,documentsReady,item.wizardProgress?.processConfirmed===true,
    (item.evidence?.people.filter((person)=>person.active).length??0)>1||item.wizardProgress?.teamSkipped===true,
    item.config?.channels.internal.configured===true||item.runtimeSetup?.telegramConfigured===true,
    item.runtimeSetup?.status==='ready',contextCurrent,item.trackerPreparation?.status==='ready'];
  const order=[0,1,4,5,6,2,3,7];const navigable=[...states];if(item.wizardProgress?.communicationsSkipped===true)navigable[4]=true;
  const pending=order.find((step)=>!navigable[step]);const complete=navigable.every(Boolean);
  return {states,complete,nextStep:pending??(complete?9:4)};
};

export const projectActiveDocuments=<T extends Readonly<{kind:string}>>(sources:readonly T[])=>{
  const documents=sources.filter(({kind})=>kind.startsWith('project_document_v1:'));
  const activeFixed=new Map<string,T>();const activeSupplemental:T[]=[];
  for(const document of documents){const category=document.kind.split(':')[1]??'';if(category==='supplemental')activeSupplemental.push(document);else if(!activeFixed.has(category))activeFixed.set(category,document);}
  const activeDocuments=[...activeFixed.values(),...activeSupplemental];const categories=new Set(activeDocuments.map(({kind})=>kind.split(':')[1]??''));
  return {activeDocuments,categories,documentsReady:categories.has('combined')||(categories.has('requirements')&&categories.has('passport'))};
};

export const projectSetupGroups=(item:ProjectSetupInput,documentsReady:boolean,contextCurrent:boolean,trackerBound:boolean)=>{
  const current=projectSetupState(item,documentsReady,contextCurrent);
  const devopsReady=item.runtimeSetup?.devops?.ssh==='configured'&&item.runtimeSetup.devops.cloudStatus!=='error';
  const states=[...current.states,trackerBound,devopsReady];
  const setup=trackerBound?{...current,states,complete:current.complete&&devopsReady,
    nextStep:current.complete?(devopsReady?10:9):current.nextStep}:{...current,states,complete:false,nextStep:8};
  const communicationsSkipped=item.wizardProgress?.communicationsSkipped===true&&states[4]!==true;
  const groups=[states[0]===true,trackerBound,states[1]===true,
    states[4]===true||communicationsSkipped,states[5]===true&&states[6]===true,
    states[2]===true&&states[3]===true&&states[7]===true&&devopsReady] as const;
  return {setup,groups,communicationsSkipped,complete:groups.filter(Boolean).length};
};
