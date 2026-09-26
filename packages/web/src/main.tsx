import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { aplicarTemaSalvo } from './theme';
import './styles.css';

aplicarTemaSalvo();

const container = document.getElementById('root');
if (!container) throw new Error('elemento #root não encontrado');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
