export type RepositoryHostPublishDraftChangeInput = Readonly<{
  repositoryTarget: string;
  baseRef: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  title: string;
  body: string;
  idempotencyKey: string;
}>;

export type RepositoryHostPublicationFailureReason =
  | 'credential_unavailable'
  | 'source_publish_failed'
  | 'change_lookup_failed'
  | 'existing_change_not_draft'
  | 'change_create_failed'
  | 'invalid_host_response';

export type RepositoryHostPublicationReceipt =
  | Readonly<{
      status: 'published';
      externalChangeRef: string;
      externalChangeUrl: string;
      externalChangeStatus: 'draft';
    }>
  | Readonly<{
      status: 'failed';
      reason: RepositoryHostPublicationFailureReason;
    }>;

export interface RepositoryHostPublisher {
  publishDraftChange(
    input: RepositoryHostPublishDraftChangeInput
  ): Promise<RepositoryHostPublicationReceipt>;
}
