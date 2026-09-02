import {listProjectHermesRuntimeBindings,listProjectOperatorEvidenceViews,listProjectSourceViews,listWorkspaceHumanActors,projectHermesExecutorCatalog,readAgentRoutingPolicy,readProjectAgentProfile,readProjectAgentSubmissionView,readProjectContextStatus,readProjectExecutionMode,readProjectHermesRuntimeSetup,readProjectMembershipRole,readProjectProcessPolicy,readProjectTrackerCapabilities,readProjectTrackerPreparation,readProjectWizardProgress,type ProjectOperatorEvidenceSection} from '@fai-control-plane/db';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {Dashboard,Process,Tasks} from './phase-a-ui.tsx';
import {executorFact} from './phase-a-view.ts';
import {integrationConfig} from './integration-config.ts';
import {TaskExecutorControl} from './operator-controls.tsx';
import {PhaseB,type PhaseBView} from './phase-b-ui.tsx';
import {getDatabase} from './runtime.ts';
import {readWorkspace} from './workspace-data.ts';

export async function OverviewPage(){const workspace=await readWorkspace();return workspace.projects===null?null:<Dashboard projects={workspace.projects}/>;}

export async function TasksPage({project:projectSlug,task,filter}:Readonly<{project?:string;task?:string;filter?:string}>){
  const workspace=await readWorkspace();if(workspace.session===null||workspace.projects===null)return null;
  const {projects,session}=workspace;const database=getDatabase();
  const invalidProject=projectSlug!==undefined&&!projects.some((project)=>project.slug===projectSlug);
  const selected=invalidProject?null:projects.find((project)=>project.slug===projectSlug)??projects[0]??null;
  const [trackerCapabilities,run,role]=selected===null?[null,null,null] as const:await Promise.all([
    readProjectTrackerCapabilities(database,session.actorId,selected.id),
    task===undefined?Promise.resolve(null):readProjectAgentSubmissionView(database,session.actorId,selected.id,task),
    readProjectMembershipRole(database,session.actorId,selected.id)
  ]);
  return <Tasks projects={projects} project={selected} task={task} filter={filter} hermesOwnerOptionId={trackerCapabilities?.agentOwnerOptionId} invalidProject={invalidProject} canManage={role==='project_owner'||role==='operator'} executorControl={(item)=>selected===null?null:<TaskExecutorControl key={`${run?.deliveryReference??item.itemId}:${run?.status??'none'}`} projectId={selected.id} currentExecutor={executorFact(item,trackerCapabilities?.agentOwnerOptionId)} confirmedRun={run} task={{itemId:item.itemId,status:item.statusOptionName,blocked:item.blocked}}/>}/>;
}

export async function ProcessPage(){
  const workspace=await readWorkspace();if(workspace.session===null||workspace.projects===null)return null;
  const {projects,session}=workspace;const database=getDatabase();const runtimes=await listProjectHermesRuntimeBindings(database,session.workspaceId);
  const runtimeByProject=new Map(runtimes.map((runtime)=>[runtime.projectId,runtime]));
  const processProjects=await Promise.all(projects.map(async(project)=>{const [role,processPolicy,executionMode,agentRouting,context]=await Promise.all([
    readProjectMembershipRole(database,session.actorId,project.id),readProjectProcessPolicy(database,session.actorId,project.id),readProjectExecutionMode(database,session.actorId,project.id),readAgentRoutingPolicy(database,session.actorId,project.id),readProjectContextStatus(database,session.actorId,project.id)
  ]);return {project,processPolicy,executionMode,context,routing:{policy:agentRouting?.policy??defaultAgentRoutingPolicy,
    executorCatalog:projectHermesExecutorCatalog(runtimeByProject.get(project.id))},canManageRouting:role==='project_owner',canManageContext:role==='project_owner'||role==='operator'};}));
  return <Process projects={processProjects}/>;
}

export async function PhaseBPage({view,setup}:Readonly<{view:PhaseBView;setup?:string|undefined}>){
  const workspace=await readWorkspace();if(workspace.session===null||workspace.projects===null)return null;
  const {projects,session}=workspace;const database=getDatabase();
  const needsEvidence=view==='conversations'||view==='people'||view==='settings';
  const evidenceSections=new Set<ProjectOperatorEvidenceSection>(view==='conversations'?['people']:view==='people'||view==='settings'?['people']:[]);
  const [operatorEvidence,sources,runtimes,workspacePeople]=await Promise.all([
    needsEvidence?listProjectOperatorEvidenceViews(database,session.actorId,evidenceSections):Promise.resolve([]),
    view==='settings'?listProjectSourceViews(database,session.actorId):Promise.resolve([]),
    listProjectHermesRuntimeBindings(database,session.workspaceId),
    view==='people'||view==='settings'?listWorkspaceHumanActors(database,session.workspaceId):Promise.resolve([])
  ]);
  const runtimeByProject=new Map(runtimes.map((runtime)=>[runtime.projectId,runtime]));
  const projectDetails=await Promise.all(projects.map(async(project)=>{const [agentProfile,runtimeSetup,trackerCapabilities,trackerPreparation,wizardProgress]=view==='settings'||view==='systems'?await Promise.all([
    readProjectAgentProfile(database,session.actorId,project.id),readProjectHermesRuntimeSetup(database,session.actorId,project.id),view==='settings'?readProjectTrackerCapabilities(database,session.actorId,project.id):Promise.resolve(null),view==='settings'?readProjectTrackerPreparation(database,session.actorId,project.id):Promise.resolve(null),view==='settings'?readProjectWizardProgress(database,session.actorId,project.id):Promise.resolve(null)
  ]):[null,null,null,null,null];return {project,agentProfile,runtimeSetup,trackerCapabilities,trackerPreparation,wizardProgress,config:integrationConfig(process.env,runtimeByProject.get(project.id)??null)};}));
  const phaseBProjects=projectDetails.map((item)=>({...item,sources,evidence:operatorEvidence.find((evidence)=>evidence.projectId===item.project.id)??null}));
  return <PhaseB view={view} projects={phaseBProjects} actorId={session.actorId} setup={setup} workspacePeople={workspacePeople}/>;
}
