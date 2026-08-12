import {runHermesRunnerLoop} from './hermes-runner';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
await runHermesRunnerLoop(process.env, controller.signal);
