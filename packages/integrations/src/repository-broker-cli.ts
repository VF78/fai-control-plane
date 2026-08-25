import {
  createControlPlaneRepositoryAuthorization,
  createGitHubAppRepositoryBroker,
  createGitHubAppTokenProvider,
  serveRepositoryBroker
} from './mvp/repository-broker.ts';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.includes('\0')) throw new Error(`${name.toLowerCase()}_required`);
  return value;
};

const authorization = createControlPlaneRepositoryAuthorization({
  endpoint: required('FCP_REPOSITORY_AUTHORIZATION_URL'),
  tokenFile: required('FCP_REPOSITORY_BRIDGE_TOKEN_FILE')
});
const tokens = createGitHubAppTokenProvider({
  appId: required('FCP_GITHUB_APP_ID'),
  installationId: required('FCP_GITHUB_APP_INSTALLATION_ID'),
  privateKeyFile: required('FCP_GITHUB_APP_PRIVATE_KEY_FILE')
});
const broker = createGitHubAppRepositoryBroker({
  root: required('FCP_REPOSITORY_WORK_ROOT'),
  stateRoot: required('FCP_REPOSITORY_BROKER_STATE_ROOT'),
  authorize: (value) => authorization.authorize(value),
  token: () => tokens.token()
});

// Fail startup when the approved App/installation/key cannot mint a token;
// readiness must prove credentials, not merely an open Unix socket.
await tokens.token();
await serveRepositoryBroker({socketPath: required('FCP_REPOSITORY_BROKER_SOCKET'), port: broker});
