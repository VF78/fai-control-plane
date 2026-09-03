import {readdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

const roots=[new URL('../',import.meta.url),new URL('../../../application/src/',import.meta.url)];
const forbidden=/(?:github|hermes|telegram|bitrix|openclaw|gitlab)/i;

const productionTypescript=async(root:URL):Promise<URL[]>=>{
  const entries=await readdir(root,{withFileTypes:true});
  const nested=await Promise.all(entries.map(async(entry)=>{
    const url=new URL(entry.name+(entry.isDirectory()?'/':''),root);
    if(entry.isDirectory())return productionTypescript(url);
    return entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts')&&!entry.name.endsWith('.spec.ts')?[url]:[];
  }));
  return nested.flat();
};

describe('provider-neutral core boundary',()=>{
  it('keeps concrete providers out of domain and application production TypeScript',async()=>{
    const files=(await Promise.all(roots.map(productionTypescript))).flat();
    const violations:string[]=[];
    for(const file of files){const source=await readFile(file,'utf8');if(forbidden.test(source))violations.push(fileURLToPath(file));}
    expect(violations).toEqual([]);
  });
});
