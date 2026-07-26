import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {OperatorShell} from './operator-ui';

it('renders actual operator deep links while preserving selected project scope', () => {
  const markup = renderToStaticMarkup(createElement(
    OperatorShell,
    {active: 'runs', scope: 'ascon', session: null},
    createElement('h1', undefined, 'Runs')
  ));

  expect(markup).toContain('href="/projects/ascon"');
  expect(markup).toContain('href="/runs?project=ascon"');
  expect(markup).toContain('href="/health?project=ascon"');
  expect(markup).toContain('aria-current="page"');
});
