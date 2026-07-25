export type RuntimeProfile = 'read_safe' | 'write_scoped';

export interface AgentRuntime {
  readonly runtimeId: string;
  run(input: {
    packetId: string;
    packetHash: string;
    workspacePath: string;
    artifactPath: string;
    profile: RuntimeProfile;
    timeboxMinutes: number;
  }): Promise<{exitCode: number; summaryRef: string}>;
}

export interface SecretsProvider {
  resolve(reference: string, purpose: string): Promise<{
    value: string;
    expiresAt?: Date;
  }>;
}

export interface ArtifactStore {
  put(input: {
    runId: string;
    name: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<{storageKey: string; sha256: string; sizeBytes: number}>;
}
