import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Styleguide } from './pages/Styleguide';
import { I18nProvider } from './i18n';
import './theme.css';
import './styles.css';
import { applyStoredTheme } from './theme';

applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {window.location.pathname === '/styleguide' ? <Styleguide /> : <App />}
    </I18nProvider>
  </StrictMode>,
);
