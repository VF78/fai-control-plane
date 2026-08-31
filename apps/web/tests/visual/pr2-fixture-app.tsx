import {createRoot} from 'react-dom/client';
import {Pr2Fixture,type Pr2FixtureState} from './pr2-fixtures.tsx';

const state=(new URLSearchParams(window.location.search).get('state')??'overview') as Pr2FixtureState;
createRoot(document.getElementById('root')!).render(<Pr2Fixture state={state}/>);
