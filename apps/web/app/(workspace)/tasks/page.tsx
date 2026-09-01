import {TasksPage} from '../../../src/mvp/workspace-pages.tsx';
export const dynamic='force-dynamic';
type Query=Readonly<{project?:string;task?:string;filter?:string}>;
export default async function Page({searchParams}:Readonly<{searchParams:Promise<Query>}>){return <TasksPage {...await searchParams}/>;}
