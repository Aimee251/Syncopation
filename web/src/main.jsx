import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Home from './Home.jsx';
import OldApp from './OldApp.jsx';
import './styles.css';

// Two pages: the new home screen at /, and the earlier page-turn version at /old.
const Page = window.location.pathname.replace(/\/+$/, '') === '/old' ? OldApp : Home;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
