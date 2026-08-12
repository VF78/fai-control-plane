import {defineConfig} from 'tsup';

export default defineConfig({
  noExternal: ['@fai-control-plane/domain']
});
