import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {AgentRoutingControl} from './operator-controls.tsx';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));

describe('agent routing dialog trigger',()=>{
  it('keeps the Process scan path to one project-qualified dialog action',()=>{
    const markup=renderToStaticMarkup(<AgentRoutingControl projectId="project" projectName="ASCON" canManage policy={defaultAgentRoutingPolicy} executorCatalog={{'codex-cli':{available:true,models:['gpt-5.6-terra','gpt-5.6-sol']}}}/>);
    expect(markup).toContain('Политика ИИ-агента');
    expect(markup).toContain('aria-label="Настроить ИИ-агента: ASCON"');
    expect(markup).toContain('9 классов задач');
    expect(markup).not.toContain('<table');expect(markup).not.toContain('<details');
  });
});
