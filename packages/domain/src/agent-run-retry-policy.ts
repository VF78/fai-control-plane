export type AgentRunRetryPolicy = Readonly<{
  maxAttempts: number;
  /** Admission closes once prior attempts have consumed this elapsed window. */
  retryUntilElapsedMinutes: number;
  /** Admission closes at this observed prior-attempt cost; it is not a runner budget. */
  maxObservedPriorCostMinor: number;
  currency: string;
  onStop: 'ask';
  stopBefore: readonly ['human_approval', 'production', 'release'];
}>;

export const MVP_AGENT_RUN_RETRY_POLICY: AgentRunRetryPolicy = Object.freeze({
  maxAttempts: 3,
  retryUntilElapsedMinutes: 120,
  maxObservedPriorCostMinor: 10_000,
  currency: 'RUB',
  onStop: 'ask',
  stopBefore: ['human_approval', 'production', 'release'] as const
});

export type AgentRunRetryStopReason = 'attempt_limit' | 'elapsed_admission_threshold' |
  'observed_prior_cost_admission_threshold' | 'cost_unknown';

export const evaluateAgentRunRetryAdmission = (facts: Readonly<{
  attemptsUsed: number;
  elapsedMinutes: number;
  observedPriorCostMinor: number | null;
  observedPriorCostExceeded: boolean;
}>, policy: AgentRunRetryPolicy = MVP_AGENT_RUN_RETRY_POLICY): AgentRunRetryStopReason | null =>
  facts.attemptsUsed >= policy.maxAttempts ? 'attempt_limit'
    : facts.elapsedMinutes >= policy.retryUntilElapsedMinutes ? 'elapsed_admission_threshold'
      : facts.observedPriorCostMinor === null ? 'cost_unknown'
        : facts.observedPriorCostExceeded ||
          facts.observedPriorCostMinor >= policy.maxObservedPriorCostMinor
          ? 'observed_prior_cost_admission_threshold' : null;
