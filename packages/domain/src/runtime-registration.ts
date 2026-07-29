export type RuntimeRegistration = Readonly<{
  id: string;
  projectId: string;
  actorId: string;
  agentProfileId: string;
  provider: string;
  runtimeKey: string;
  enabled: boolean;
  version: number;
}>;
