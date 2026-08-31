import {createRoot} from 'react-dom/client';
import {ProjectsFixture,type ProjectsFixtureState} from './projects-setup-fixtures.tsx';

const state=(new URLSearchParams(window.location.search).get('state')??'two') as ProjectsFixtureState;
createRoot(document.getElementById('root')!).render(<ProjectsFixture state={state}/>);
