import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {ProjectOutcomeAcceptanceControls} from './project-outcome-acceptance-controls';

const props = {projectId: 'project-1', baselineId: 'baseline-1', outcomeId: 'outcome-1', expectedExecutionVersion: 2, weight: 45, csrfToken: 'csrf', enabled: true};
it('renders one Russian Product Owner command with weighted trace only when canonical facts permit it', () => {
  const markup = renderToStaticMarkup(createElement(ProjectOutcomeAcceptanceControls, props));
  expect(markup).toContain('Принять результат · +45');
  expect(markup).toContain('fcp-outcome-acceptance');
  expect(renderToStaticMarkup(createElement(ProjectOutcomeAcceptanceControls, {...props, enabled: false}))).toBe('');
  expect(renderToStaticMarkup(createElement(ProjectOutcomeAcceptanceControls, {...props, csrfToken: null}))).toBe('');
});
