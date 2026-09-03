import {readFile} from 'node:fs/promises';
import type {SecretResolverPort} from '@fai-control-plane/domain';

export const projectRuntimeSecrets:SecretResolverPort={async resolve(reference,expectedPurpose){
  if(reference.purpose!==expectedPurpose||!reference.locator.startsWith('/'))throw new Error('secret_reference_denied');
  const value=(await readFile(reference.locator,'utf8')).trim();
  if(value.length===0||value.length>65_536||value.includes('\0'))throw new Error('secret_invalid');
  return {value};
}};
