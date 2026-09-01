import {PhaseBPage} from '../../../src/mvp/workspace-pages.tsx';
export const dynamic='force-dynamic';
type Query=Readonly<{setup?:string}>;
export default async function Page({searchParams}:Readonly<{searchParams:Promise<Query>}>){return <PhaseBPage view="settings" setup={(await searchParams).setup}/>;}
