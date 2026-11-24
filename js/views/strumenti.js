// js/views/strumenti.js — "Strumenti" index: extensible list of small tools.
// To add a tool, append a definition to TOOLS and register its route in app.js.
import { el } from '../ui.js';
import { navigate } from '../router.js';

export const TOOLS = [
  {
    id: 'porzioni',
    icon: '🍝',
    title: 'Calcolo porzioni cotte',
    description: 'Dividi pasta o riso cotti in base al peso da crudo.',
    route: '/strumenti/porzioni',
  },
];

export function render(container) {
  const list = el('div', { class: 'card list-card' });
  for (const tool of TOOLS) {
    const row = el('div', { class: 'row', role: 'button', tabindex: '0' }, [
      el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, tool.icon),
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, tool.title),
        el('div', { class: 'row-sub' }, tool.description),
      ]),
      el('span', { class: 'tool-chevron', 'aria-hidden': 'true' }, '›'),
    ]);
    row.addEventListener('click', () => navigate(tool.route));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigate(tool.route);
      }
    });
    list.appendChild(row);
  }
  container.appendChild(el('h2', { class: 'tool-title' }, 'Strumenti'));
  container.appendChild(list);
  return { destroy() {} };
}
