import {runDeploymentExecutorLoop} from './client';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
await runDeploymentExecutorLoop(process.env, controller.signal);
