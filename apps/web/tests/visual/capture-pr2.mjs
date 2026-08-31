import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdir,readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const playwright=await import(process.env.FCP_PLAYWRIGHT_PACKAGE??'@playwright/test');
const {chromium}=playwright.default??playwright;

const here=dirname(fileURLToPath(import.meta.url));
const temporary='/private/tmp/fai-ui-pr2/harness';
await mkdir(temporary,{recursive:true});
await build({entryPoints:[join(here,'pr2-fixture-app.tsx')],bundle:true,format:'esm',platform:'browser',outfile:join(temporary,'fixture.js'),jsx:'automatic',plugins:[{name:'fixture-runtime',setup(builder){builder.onResolve({filter:/^next\/navigation$/},()=>({path:'next/navigation',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`export const useRouter=()=>({refresh(){},push(){},replace(){}});`}));builder.onResolve({filter:/^next\/link$/},()=>({path:'next/link',namespace:'fixture-link'}));builder.onLoad({filter:/.*/,namespace:'fixture-link'},()=>({loader:'js',resolveDir:here,contents:`import {createElement} from 'react';export default function Link({href,children,...props}){return createElement('a',{href,...props},children)}`}));builder.onResolve({filter:/^node:crypto$/},()=>({path:'node:crypto',namespace:'fixture-crypto'}));builder.onLoad({filter:/.*/,namespace:'fixture-crypto'},()=>({loader:'js',contents:`export function createHash(){let value='';return {update(next){value+=String(next);return this},digest(){let hash=2166136261;for(let index=0;index<value.length;index++){hash^=value.charCodeAt(index);hash=Math.imul(hash,16777619)}return (hash>>>0).toString(16).padStart(8,'0').repeat(8)}}}`}));}}]});
const html='<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const css=(await Promise.all(['../../app/styles/controls.css','../../app/styles/tokens.css','../../app/styles/foundation.css','../../app/styles/projects.css'].map((path)=>readFile(join(here,path),'utf8')))).join('\n');
const server=createServer(async(request,response)=>{if(request.url==='/fixture.js'){response.setHeader('content-type','text/javascript');response.end(await readFile(join(temporary,'fixture.js')));}else if(request.url==='/fixture.css'){response.setHeader('content-type','text/css');response.end(css);}else{response.setHeader('content-type','text/html');response.end(html);}});
await new Promise((resolve)=>server.listen(3098,'127.0.0.1',resolve));
if(process.env.FCP_CAPTURE_SERVE==='1')await new Promise(()=>{});
const output=process.env.FCP_CAPTURE_DIR??'/private/tmp/fai-ui-pr2/after';
const compareDirectory=process.env.FCP_CAPTURE_COMPARE_DIR;
if(compareDirectory!==undefined&&compareDirectory===output)throw new Error('FCP_CAPTURE_DIR must differ from FCP_CAPTURE_COMPARE_DIR');
const viewports=[['1440x900',1440,900],['1280x800',1280,800],['390x844',390,844]];
const states=(process.env.FCP_CAPTURE_STATES??'login,overview,tasks,tasks-stale,tasks-empty,process').split(',');
await mkdir(output,{recursive:true});const browser=await chromium.launch({channel:'chrome',headless:true});try{for(const [name,width,height] of viewports){const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors=[];page.on('pageerror',(error)=>errors.push(error.message));for(const state of states){await page.goto(`http://127.0.0.1:3098/?state=${state}`,{waitUntil:'networkidle'});await page.locator('#root > *').waitFor({state:'attached'});if(errors.length>0)throw new Error(errors.join('\n'));const text=(await page.locator('#root').innerText()).trim();if(!text)throw new Error(`empty fixture for ${state}`);if(name==='390x844'&&state==='tasks'){const ready=page.getByRole('tab',{name:/Ready/});await ready.press('ArrowRight');if(await page.getByRole('tab',{name:/In Dev/}).getAttribute('aria-selected')!=='true')throw new Error('ArrowRight must select In Dev');await page.getByRole('tab',{name:/In Dev/}).press('End');if(await page.getByRole('tab',{name:/Done/}).getAttribute('aria-selected')!=='true')throw new Error('End must select Done');}console.log(`${state}-${name}: ${text.slice(0,80)}`);await page.screenshot({path:`${output}/${state}-${name}.png`,fullPage:false});}await page.close();}}finally{await browser.close();await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}

if(compareDirectory!==undefined){
  const pngNames=async(directory)=>(await readdir(directory)).filter((name)=>name.endsWith('.png')).sort();
  const actual=await pngNames(output);
  const expected=await pngNames(compareDirectory);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`visual baseline file set differs: actual=${actual.join(',')} expected=${expected.join(',')}`);
  for(const name of actual){
    const [candidate,golden]=await Promise.all([readFile(join(output,name)),readFile(join(compareDirectory,name))]);
    const digest=(value)=>createHash('sha256').update(value).digest('hex');
    if(digest(candidate)!==digest(golden))throw new Error(`visual baseline mismatch: ${name}`);
  }
  console.log(`visual baseline compare passed: ${actual.length} PNGs`);
}
