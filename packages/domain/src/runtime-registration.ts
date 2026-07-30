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

export type RuntimeRegistrationReplacement = Readonly<{
  source: RuntimeRegistration;
  target: RuntimeRegistration;
}>;

export const replaceRuntimeRegistrations = (
  source: RuntimeRegistration,
  target: RuntimeRegistration
): RuntimeRegistrationReplacement | null => {
  if (
    source.id === target.id ||
    source.projectId !== target.projectId ||
    source.actorId === target.actorId ||
    source.agentProfileId === target.agentProfileId ||
    !source.enabled ||
    target.enabled
  ) return null;
  return {
    source: {...source, enabled: false, version: source.version + 1},
    target: {...target, enabled: true, version: target.version + 1}
  };
};
