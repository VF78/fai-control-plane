import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const read = (relative: string) => readFile(new URL(`../../../${relative}`, import.meta.url), 'utf8');

describe('deployment executor host examples', () => {
  it('ships disabled with no registered production adapter or install target', async () => {
    const [environment, service] = await Promise.all([
      read('infra/production/fai-deployment-executor.env.example'),
      read('infra/production/fai-deployment-executor.service')
    ]);
    expect(environment).toContain('FAI_DEPLOYMENT_EXECUTOR_ENABLED=false\n');
    expect(environment).toContain('FAI_DEPLOYMENT_EXECUTOR_DRY_RUN=true\n');
    expect(environment).toContain('FAI_DEPLOYMENT_EXECUTOR_ADAPTER=unavailable\n');
    expect(environment).toContain('FAI_DEPLOYMENT_EXECUTOR_CONFIRM_ACTIVATION=REPLACE_WITH_EXPLICIT_CONFIRMATION\n');
    expect(environment).toContain('/var/lib/fai-deployment-executor/credentials/claim-token');
    expect(environment).toContain('FAI_DEPLOYMENT_EXECUTOR_SOCKET_PATH=/run/fai-deployment-api/control.sock');
    expect(environment).not.toContain('FAI_DEPLOYMENT_EXECUTOR_BASE_URL');
    expect(environment).not.toMatch(/https?:\/\//);
    expect(environment).toContain('must support Linux O_TMPFILE');
    expect(service).not.toContain('WantedBy=');
    expect(service).not.toContain('scripts/deploy-prod.sh');
  });

  it('uses a distinct unprivileged identity and denies other runtime credentials', async () => {
    const service = await read('infra/production/fai-deployment-executor.service');
    for (const directive of ['User=fai-deployment-executor', 'Group=fai-deployment-executor',
      'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateDevices=true',
      'CapabilityBoundingSet=', 'UMask=0077', 'RestrictAddressFamilies=AF_UNIX',
      'ReadOnlyPaths=/run/fai-deployment-api',
      'ReadWritePaths=/var/lib/fai-deployment-executor/staging']) expect(service).toContain(directive);
    expect(service).not.toContain('AF_INET');
    expect(service).toContain('InaccessiblePaths=/var/lib/fai-hermes-controller /etc/fai-hermes-controller');
    expect(service).toContain('/var/lib/fai-codex-executor /etc/fai-codex-executor /etc/fai-control-plane');
  });
});
