// js/views/other-services.js — "Prova gli altri servizi" cross-promo section (Impostazioni).
// Lists the two sibling apps (GymBro, DeDDMTool) — NOT IndiSpesabile — each as a whole-row
// anchor. The anchors are plain top-level same-tab navigations (no target="_blank"), so when
// the sibling app is installed as a PWA the OS/browser hands off and opens it standalone —
// mirroring how IndiSpesabile's own link opens standalone from the other apps. A "?" toggle
// reveals a short per-app description, collapsed by default.
// Built entirely with the `el` helper; all strings Italian.

import { el } from '../ui.js';

// The two sibling apps. IndiSpesabile itself is intentionally excluded.
const APPS = [
  {
    name: 'GymBro',
    url: 'https://stranu.github.io/GymBro',
    icon: 'https://stranu.github.io/GymBro/icons/icon-192.png',
    desc: 'App per tracciare i tuoi allenamenti e progressi in palestra.',
  },
  {
    name: 'DeDDMTool',
    url: 'https://stranu.github.io/DeDDMTool',
    icon: 'https://stranu.github.io/DeDDMTool/icons/icon-192.png',
    desc: 'Strumento per gestire le sessioni di Dungeons & Dragons.',
  },
];

// render() — returns the <section> for the Account/Impostazioni modal.
export function render() {
  const descLines = [];
  APPS.forEach((app, i) => {
    if (i > 0) descLines.push(el('br'));
    descLines.push(el('strong', {}, app.name));
    descLines.push(` — ${app.desc}`);
  });
  const desc = el(
    'p',
    { id: 'other-services-desc', class: 'other-services-desc', hidden: true },
    descLines
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
