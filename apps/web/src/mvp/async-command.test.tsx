import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {AsyncButton} from './async-command.tsx';

describe('async command button', () => {
  it('renders an immediate, disabled and accessible pending state', () => {
    const markup = renderToStaticMarkup(
      <AsyncButton pending pendingLabel="Запускаем…">Запустить заново</AsyncButton>
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('fcp-button-spinner');
    expect(markup).toContain('Запускаем…');
    expect(markup).not.toContain('Запустить заново');
  });
});
