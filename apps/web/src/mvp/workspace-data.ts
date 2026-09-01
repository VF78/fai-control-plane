import {listProjectTaskViews} from '@fai-control-plane/db';
import {cache} from 'react';
import {getDatabase,requireSession} from './runtime.ts';

export const readWorkspace = cache(async () => {
  let session:Awaited<ReturnType<typeof requireSession>>|null=null;
  try{session=await requireSession();}catch{return {session:null,projects:null};}
  try{return {session,projects:await listProjectTaskViews(getDatabase(),session.actorId)};}
  catch{return {session,projects:null};}
});
