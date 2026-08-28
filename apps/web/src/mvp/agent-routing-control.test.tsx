import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {defaultAgentRoutingPolicy} from '@fai-control-plane/domain';
import {AgentRoutingControl} from './operator-controls.tsx';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));

describe('agent routing inline editor',()=>{
  it('keeps compact per-field actions without a duplicate editor',()=>{
    const markup=renderToStaticMarkup(<AgentRoutingControl projectId="project" canManage policy={defaultAgentRoutingPolicy} executorCatalog={{'codex-cli':{available:true,models:['gpt-5.6-terra','gpt-5.6-sol']}}}/>);
    expect(markup).toContain('Рассуждение');expect(markup).toContain('Среднее');expect(markup).toContain('Высокое');
    expect(markup).toContain('aria-label="Изменить: Модель"');expect(markup).toContain('aria-label="Изменить: Рассуждение"');
    expect(markup).not.toContain('<table');expect(markup).not.toContain('<details');
  });
});
