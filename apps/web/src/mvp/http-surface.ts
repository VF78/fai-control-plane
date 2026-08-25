export const mvpApiRoutes = Object.freeze([
  '/api/auth/github/login',
  '/api/auth/logout',
  '/api/projects',
  '/api/projects/[projectId]/agent-profile',
  '/api/access/onboarding',
  '/api/access/memberships/[id]',
  '/api/projects/[projectId]/sources',
  '/api/projects/[projectId]/agent-routing',
  '/api/projects/[projectId]/context/refresh',
  '/api/approvals/[id]',
  '/api/tasks/executor',
  '/api/webhooks/github',
  '/api/hermes/conversation-actions',
  '/api/health',
  '/api/ready'
] as const);

export type MvpApiRoute = (typeof mvpApiRoutes)[number];
export const mvpOAuthCallbackRoute = '/oauth/github/complete' as const;

export type OperatorProjectView = Readonly<{
  id: string;
  slug: string;
  name: string;
  repositoryUrl: string;
  tracker: Readonly<{
    sourceUrl: string;
    observedAt: string | null;
    errorCode: string | null;
    itemCount: number;
  }>;
  sourceCount: number;
  pendingDeliveryCount: number;
}>;

export const readiness = (input: Readonly<{
  database: boolean;
}>): Readonly<{ready: boolean; checks: Readonly<Record<string, boolean>>}> => ({
  ready: input.database,
  checks: {database: input.database}
});
