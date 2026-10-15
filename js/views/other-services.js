// js/views/other-services.js — "Prova gli altri servizi" cross-promo section (Impostazioni).
// Lists the two sibling apps (GymBro, DeDDMTool) — NOT IndiSpesabile — each as a whole-row
// anchor opening in a new tab. A "?" toggle reveals a short description, collapsed by default.
// Built entirely with the `el` helper; all strings Italian.

import { el } from '../ui.js';

// The two sibling apps. IndiSpesabile itself is intentionally excluded.
const APPS = [
  {
    name: 'GymBro',
    url: 'https://stranu.github.io/GymBro',
    icon: 'https://stranu.github.io/GymBro/icons/icon-192.png',
  },
  {
    name: 'DeDDMTool',
    url: 'https://stranu.github.io/DeDDMTool',
    icon: 'https://stranu.github.io/DeDDMTool/icons/icon-192.png',
  },
];

// render() — returns the <section> for the Account/Impostazioni modal.
export function render() {
  const desc = el(
    'p',
    { id: 'other-services-desc', class: 'other-services-desc', hidden: true },
    'Altri strumenti gratuiti che ho realizzato. IndiSpesabile e GymBro condividono lo stesso account; DeDDMTool è uno strumento per le sessioni di D&D.'
  );

  const helpToggle = el(
    'button',
    {
      type: 'button',
      class: 'help-toggle',
      'aria-label': 'Mostra dettagli',
      'aria-expanded': 'false',
      'aria-controls': 'other-services-desc',
      onClick: () => {
        desc.hidden = !desc.hidden;
        helpToggle.setAttribute('aria-expanded', String(!desc.hidden));
      },
    },
    '?'
  );

  const head = el('div', { class: 'other-services-head' }, [
    el('h3', { class: 'other-services-title' }, 'Prova gli altri servizi'),
    helpToggle,
  ]);

  const list = el(
    'div',
    { class: 'other-services-list' },
    APPS.map((app) =>
      el(
        'a',
        {
          class: 'other-service',
          href: app.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        [
          el('img', {
            class: 'other-service-icon',
            src: app.icon,
            alt: '',
            width: 40,
            height: 40,
            loading: 'lazy',
          }),
          el('span', { class: 'other-service-name' }, app.name),
        ]
      )
    )
  );

  return el('section', { class: 'other-services' }, [head, desc, list]);
}
