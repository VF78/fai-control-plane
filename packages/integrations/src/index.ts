import type {WorkItemStatus} from '@fai-control-plane/domain';

export * from './inbound-events';
export * from './github-webhook';

export type TrackerCapabilities = {
  readWorkItems: boolean;
  writeWorkItems: boolean;
  readPullRequests: boolean;
  readChecks: boolean;
};

export interface TrackerAdapter {
  readonly provider: string;
  capabilities(): TrackerCapabilities;
  transitionWorkItem(input: {
    bindingId: string;
    expectedVersion: number;
    status: WorkItemStatus;
    idempotencyKey: string;
  }): Promise<{externalVersion: string}>;
}

export interface ChatAdapter {
  readonly provider: string;
  sendSafeNotification(input: {
    destinationRef: string;
    template: string;
    variables: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{externalMessageId: string}>;
}
