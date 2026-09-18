import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const validator=new URL('./validate-env.mjs',import.meta.url);
test('private/public identity and unsafe override validation',()=>{
  const directory=mkdtempSync(join(tmpdir(),'paperclip-env-'));
  try {
    const password='p'.repeat(40),secret='a'.repeat(64);
    const materialize=name=>readFileSync(new URL(name,import.meta.url),'utf8').replace('REPLACE_HOST_OWNED_PASSWORD',password).replaceAll('REPLACE_HOST_OWNED_RANDOM_SECRET',secret);
    const production=materialize('production.env.example'),bootstrap=materialize('bootstrap.env.example');
    const paths=['production','bootstrap','password'].map(name=>join(directory,name));
    writeFileSync(paths[2],password);
    const check=(publicEnv,privateEnv)=>{writeFileSync(paths[0],publicEnv);writeFileSync(paths[1],privateEnv);return spawnSync(process.execPath,[validator.pathname,...paths],{stdio:'ignore'}).status;};
    assert.equal(check(production,bootstrap),0);
    assert.notEqual(check(production.replace('SIGN_UP=true','SIGN_UP=false'),bootstrap),0);
    assert.notEqual(check(production,bootstrap.replace('PORT=13110','PORT=13010')),0);
    assert.notEqual(check(production+'PAPERCLIP_BIND=lan\n',bootstrap),0);
    assert.notEqual(check(production+'PORT=13010\n',bootstrap),0);
    assert.notEqual(check(production,bootstrap.replace(secret,'b'.repeat(64))),0);
    writeFileSync(paths[2],'wrong');
    assert.notEqual(check(production,bootstrap),0);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
