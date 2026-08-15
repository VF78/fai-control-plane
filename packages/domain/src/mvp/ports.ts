import type {
  ApprovalEvidence,
  OpaqueSecretRef,
  SourceReference,
  TrackerSnapshot
} from './model.ts';

export type TrackerReadPort = Readonly<{
  readSnapshot(bindingId: string, cursor: string | null): Promise<TrackerSnapshot>;
}>;

export type TrackerMutationPort = Readonly<{
  createIssue(input: Readonly<{
    projectId: string;
    title: string;
    statement: string;
    idempotencyKey: string;
  }>): Promise<Readonly<{referenceId: string; url: string; version: string}>>;
  addIssueContext(input: Readonly<{
    referenceId: string;
    expectedVersion: string;
    statement: string;
    idempotencyKey: string;
  }>): Promise<Readonly<{referenceId: string; url: string; version: string}>>;
}>;

/** Provider-neutral observation of the repository named by a tracker binding. */
export type RepositoryReadPort = Readonly<{
  readRepository(input: Readonly<{repositoryId: string}>): Promise<Readonly<{
    repositoryId: string;
    url: string;
    defaultBranch: string;
    observedAt: string;
  }>>;
}>;

export type SecretResolverPort = Readonly<{
  resolve(reference: OpaqueSecretRef, expectedPurpose: string): Promise<Readonly<{value: string}>>;
}>;

export type AgentRole = 'manager' | 'developer' | 'qa' | 'devops';
export type AgentRoleRequest = Readonly<{
  role: AgentRole;
  repository: Readonly<{id: string; url: string}>;
  projectItem: Readonly<{id: string; projectId: string; issueId: string; url: string}>;
  observedVersion: string;
  sources: readonly SourceReference[];
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
  approval: ApprovalEvidence | null;
  correlationId: string;
  idempotencyKey: string;
}>;

export type AgentDeliveryPort = Readonly<{
  submit(request: AgentRoleRequest): Promise<Readonly<{
    deliveryReference: string;
    sessionReference: string;
  }>>;
}>;

type MessengerInboundBase = Readonly<{
  projectId: string;
  channelReference: string;
  senderReference: string;
  messageReference: string;
  observedAt: string;
  text: string;
  correlationId: string;
  idempotencyKey: string;
}>;

/** The contour is assigned by static composition, never by a webhook caller. */
export type InternalMessengerInbound = MessengerInboundBase & Readonly<{contour: 'trusted-main'}>;
export type ClientMessengerInbound = MessengerInboundBase & Readonly<{contour: 'client-edge'}>;
export type MessengerInbound = InternalMessengerInbound | ClientMessengerInbound;

export type MessengerIngressPort = Readonly<{
  receive(input: Readonly<{
    headers: Readonly<Record<string, string | undefined>>;
    body: Uint8Array;
  }>): Promise<Readonly<
    | {status: 'accepted'; message: MessengerInbound}
    | {status: 'rejected'; reason: string}
  >>;
}>;

export type MessengerDeliveryInput = Readonly<{
  projectId: string;
  contour: 'trusted-main' | 'client-edge';
  channelReference: string;
  text: string;
  idempotencyKey: string;
}>;

export type MessengerDeliveryPort = Readonly<{
  send(input: MessengerDeliveryInput): Promise<Readonly<{deliveryReference: string}>>;
}>;

export type ConversationRuntimeDeliveryPort<TMessage extends MessengerInbound = MessengerInbound> = Readonly<{
  deliver(message: TMessage): Promise<Readonly<{deliveryReference: string}>>;
}>;
