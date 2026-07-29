import type {CommandResult, ProjectionAvailability, WorkItemStatus} from './index.ts';
import type {
  DeliveryProtocol,
  DeliveryProtocolExecutionMode,
  DeliveryProtocolResponsibility,
  DeliveryProtocolStage
} from './delivery-protocol.ts';

export type DeliveryEvidenceReference = Readonly<{requirement: string; reference: string}>;
export type DeliveryJourney = Readonly<{
  workItemId: string;
  protocolId: string;
  protocolVersion: number;
  stageKey: string;
  deadlineAt: string | null;
  version: number;
}>;
export type DeliveryJourneyDeadline =
  | Readonly<{state: 'not_set'; at: null}>
  | Readonly<{state: 'upcoming' | 'overdue' | 'completed'; at: string}>;
export type DeliveryJourneyProjection =
  | Readonly<{
      state: 'not_configured';
      task: Readonly<{id: string; status: WorkItemStatus; version: number}>;
      reason: 'protocol_not_bound';
    }>
  | Readonly<{
      state: 'configured';
      task: Readonly<{id: string; status: WorkItemStatus; version: number}>;
      protocol: Readonly<{id: string; version: number}>;
      journeyVersion: number;
      stage: Readonly<{
        key: string;
        name: string;
        taskStatus: WorkItemStatus;
        executionMode: DeliveryProtocolExecutionMode;
      }>;
      responsibility: Readonly<{
        configured: DeliveryProtocolResponsibility;
        actor: ProjectionAvailability<Readonly<{
          id: string; displayName: string; type: 'human' | 'agent';
        }>>;
        agentProfile: ProjectionAvailability<Readonly<{id: string}>>;
      }>;
      deadline: DeliveryJourneyDeadline;
      requiredEvidence: readonly Readonly<{requirement: string; references: readonly string[]}>[];
      nextAllowedAction:
        | Readonly<{
            kind: 'advance';
            toStageKey: string;
            expectedWorkItemVersion: number;
            expectedJourneyVersion: number;
          }>
        | Readonly<{
            kind: 'blocked';
            reason: 'work_item_blocked' | 'responsibility_unresolved' |
              'journey_complete';
          }>;
    }>;

export const firstEnabledDeliveryStage = (protocol: DeliveryProtocol): DeliveryProtocolStage | null =>
  protocol.definition.stages.find((stage) => stage.enabled) ?? null;
export const nextEnabledDeliveryStage = (
  protocol: DeliveryProtocol,
  stageKey: string
): DeliveryProtocolStage | null => {
  const stage = protocol.definition.stages.find((candidate) => candidate.key === stageKey);
  if (stage?.enabled !== true || stage.allowedNextStageKey === null) return null;
  const next = protocol.definition.stages.find(
    (candidate) => candidate.key === stage.allowedNextStageKey
  );
  return next?.enabled === true ? next : null;
};
const failure = <T>(message: string): CommandResult<T> => ({
  ok: false, error: {code: 'INVALID_COMMAND', message}
});
export const validateDeliveryEvidenceReferences = (
  stage: DeliveryProtocolStage,
  value: unknown
): CommandResult<readonly DeliveryEvidenceReference[]> => {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length ||
    value.length !== stage.requiredEvidence.length) {
    return failure('Every required delivery evidence item must have one reference.');
  }
  const seen = new Set<string>();
  const result: DeliveryEvidenceReference[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item) ||
      Object.keys(item).length !== 2 || !Object.hasOwn(item, 'requirement') ||
      !Object.hasOwn(item, 'reference')) {
      return failure('Delivery evidence references are not canonical.');
    }
    const record = item as Record<string, unknown>;
    if (typeof record.requirement !== 'string' ||
      !stage.requiredEvidence.includes(record.requirement) || seen.has(record.requirement) ||
      typeof record.reference !== 'string' || record.reference.trim() !== record.reference ||
      record.reference.length === 0 || record.reference.length > 2_048) {
      return failure('Delivery evidence references are not canonical.');
    }
    seen.add(record.requirement);
    result.push({requirement: record.requirement, reference: record.reference});
  }
  return stage.requiredEvidence.some((requirement) => !seen.has(requirement))
    ? failure('Every required delivery evidence item must have one reference.')
    : {ok: true, value: Object.freeze(result.map((entry) => Object.freeze(entry)))};
};
