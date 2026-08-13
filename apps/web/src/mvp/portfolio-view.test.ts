import {describe, expect, it} from 'vitest';
import {buildPortfolioProject, type PortfolioProjectInput} from './portfolio-view.ts';

const project = (tasks: PortfolioProjectInput['tasks']): PortfolioProjectInput => ({
  id: 'ascon', name: 'ASCON', repositoryUrl: 'https://github.com/VF78/ascon',
  tracker: {sourceUrl: 'https://github.com/users/VF78/projects/4', observedAt: '2026-08-13T09:00:00.000Z',
    freshness: 'fresh', errorCode: null}, tasks
});
const task = (issueId: string, statusOptionName: string, targetDate: string | null) => ({
  itemId: `item-${issueId}`, issueId, title: `Issue ${issueId}`, url: `https://github.com/VF78/ascon/issues/${issueId}`,
  statusOptionName, blocked: statusOptionName === 'Blocked', targetDate
});

describe('portfolio view', () => {
  it('renders an at-most-two-item, provider-native decision summary', () => {
    const view = buildPortfolioProject(project([
      task('1', 'Done', null), task('2', 'QA', '2026-08-12'), {...task('3', 'Acceptance', '2026-08-24'), blocked: true},
      task('4', 'Acceptance', '2026-08-24')
    ]), new Date('2026-08-13T12:00:00.000Z'));
    expect(view).toMatchObject({total: 4, done: 1, open: 3, blocked: 1, overdue: 1,
      phase: 'QA · Acceptance', nextControl: '2026-08-24', health: 'attention',
      sourceUrl: 'https://github.com/users/VF78/projects/4'});
    expect(view.focus.map((item) => item.issueId)).toEqual(['2', '3']);
    expect(view.decision?.issueId).toBe('2');
  });

  it('does not invent a blocked count when the provider has no blocked fact', () => {
    const input = project([{...task('5', 'QA', '2026-08-24'), blocked: null}]);
    const view = buildPortfolioProject(input, new Date('2026-08-13T12:00:00.000Z'));
    expect(view).toMatchObject({blocked: null, overdue: 0, health: 'steady'});
  });
});
