import {redirect} from 'next/navigation';
import {legacyPath} from '../src/mvp/navigation.ts';

export const dynamic='force-dynamic';
type Query=Readonly<Record<string,string|string[]|undefined>>;

export default async function CompatibilityEntry({searchParams}:Readonly<{searchParams:Promise<Query>}>){redirect(legacyPath(await searchParams));}
