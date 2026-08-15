import type {TrackerItemFact} from '@fai-control-plane/domain';
import {AgentSubmitControlClient} from './operator-controls.tsx';

export const eligibleHermesTasks = (
  tasks: readonly TrackerItemFact[], doneStatusOptionId: string | undefined,
  hermesOwnerOptionId: string | undefined
): readonly TrackerItemFact[] => doneStatusOptionId === undefined || hermesOwnerOptionId === undefined ? [] : tasks.filter((task) =>
  task.statusOptionId !== null && task.statusOptionId !== doneStatusOptionId &&
  task.ownerOptionId === hermesOwnerOptionId
);

export function AgentSubmitControl({projectId, tasks, sources}: Readonly<{
  projectId: string;
  tasks: readonly TrackerItemFact[];
  sources: readonly {id: string; name: string; kind: string}[];
}>) {
  const doneStatusOptionId = process.env.STATUS_DONE_ID;
  const hermesOwnerOptionId = process.env.HERMES_TRACKER_OWNER_OPTION_ID;
  const eligible = eligibleHermesTasks(tasks, doneStatusOptionId, hermesOwnerOptionId);
  return <AgentSubmitControlClient projectId={projectId} tasks={eligible} sources={sources}/>;
}
