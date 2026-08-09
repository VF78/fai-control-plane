/**
 * Portable operator-language contracts. These are serializable on purpose:
 * the web BFF owns URLs and DOM rendering, while a future client can map the
 * same reference and receipt shapes to its own navigation and presentation.
 */
export type OperatorScreenRef =
  | Readonly<{kind: 'dashboard'}>
  | Readonly<{kind: 'projects'}>
  | Readonly<{kind: 'project'; projectSlug: string; section: 'overview' | 'tasks' | 'protocol' | 'runs' | 'chats' | 'access'}>
  | Readonly<{kind: 'task'; projectSlug: string; taskId: string}>
  | Readonly<{kind: 'run'; projectSlug: string; runId: string}>
  | Readonly<{kind: 'agents'}>
  | Readonly<{kind: 'agent'; agentId: string}>;

export type OperatorScopeRef = Readonly<{
  environment: string | null;
  from: string | null;
  to: string | null;
}>;

/** Facts that can be displayed in a receipt without implying an immutable
 * command log. Every field is optional because a provider may not persist it. */
export type OperatorReceiptFacts = Readonly<{
  runId: string;
  taskId: string | null;
  decisionId: string | null;
  actor: string | null;
  environment: string | null;
  outcome: string | null;
  observedAt: string | null;
  checks: readonly string[];
  evidence: readonly string[];
}>;

export type OperatorCommandPort = Readonly<{
  command: string;
  target: OperatorScreenRef;
  requiresApproval: boolean | null;
}>;

export type OperatorReceiptPort = Readonly<{
  facts: OperatorReceiptFacts;
  nextAction: string | null;
}>;
