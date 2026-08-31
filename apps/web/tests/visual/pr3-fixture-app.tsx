import {createRoot} from 'react-dom/client';
import {Pr3Fixture,type Pr3FixtureState} from './pr3-fixtures.tsx';

const state=(new URLSearchParams(window.location.search).get('state')??'chats-configured') as Pr3FixtureState;
createRoot(document.getElementById('root')!).render(<Pr3Fixture state={state}/>);
