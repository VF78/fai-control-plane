import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {AgentRoutingControl} from './operator-controls.tsx';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../ui/foundation.tsx',()=>({Dialog:({children}:{children:import('react').ReactNode})=><>{children}</>}));

describe('agent routing dialog trigger',()=>{
  it('uses supplied catalog models and retains an opaque saved selection',()=>{
    const policy={...defaultAgentRoutingPolicy,routes:defaultAgentRoutingPolicy.routes.map((route,index)=>
      index===0?{...route,model:'project-private-model'}:route)};
    const markup=renderToStaticMarkup(<AgentRoutingControl projectId="project" projectName="ASCON" canManage
      policy={policy} executorCatalog={{'codex-cli':{available:true,models:['gpt-6-astra','gpt-5.6-luna']}}}/>);
    expect(markup).toContain('<option value="gpt-6-astra">GPT-6 Astra</option>');
    expect(markup).toContain('<option value="gpt-5.6-luna">GPT-5.6 Luna</option>');
    expect(markup).toContain('<option value="project-private-model" selected="">project-private-model</option>');
    expect(markup).not.toContain('<option value="gpt-5.6-terra">');
  });
  it('keeps the Process scan path to one project-qualified dialog action',()=>{
    const markup=renderToStaticMarkup(<AgentRoutingControl projectId="project" projectName="ASCON" canManage policy={defaultAgentRoutingPolicy} executorCatalog={{'codex-cli':{available:true,models:['gpt-5.6-terra','gpt-5.6-sol']}}}/>);
    expect(markup).toContain('Политика ИИ-агента');
    expect(markup).toContain('aria-label="Настроить ИИ-агента: ASCON"');
    expect(markup).toContain('9 классов задач');
    expect(markup).not.toContain('<table');expect(markup).not.toContain('<details');
  });
});
