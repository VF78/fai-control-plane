export const mvpApiRoutes = Object.freeze([
  '/api/auth/github/login',
  '/api/auth/logout',
  '/api/projects',
  '/api/access/onboarding',
  '/api/access/memberships/[id]',
  '/api/projects/[projectId]/sources',
  '/api/approvals/[id]',
  '/api/webhooks/github',
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
