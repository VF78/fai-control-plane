import {runWorkstationRunnerFromEnvironment} from './workstation-runner';

const result = await runWorkstationRunnerFromEnvironment();
process.stdout.write(`${result.status}\n`);
