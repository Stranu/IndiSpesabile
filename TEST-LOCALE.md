# Test locale di IndiSpesabile

Guida rapida per provare l'app in locale senza deployare su GitHub Pages ogni volta.
Richiede Node (già installato: v24).

## Avvio del server statico

Apri un terminale nella cartella del progetto:

```
cd c:\Tools\external\IndiSpesabile
npx serve . -l 5173
```

La prima volta ti verrà chiesto di installare `serve`: conferma. Poi apri
`http://localhost:5173` nel browser.

Alternative (sempre via Node, o Python se preferisci):

```
npx http-server . -p 5173
python -m http.server 5173
```

> Serve un server HTTP: i moduli ES e il service worker NON funzionano
> aprendo `index.html` da `file://`. Serve `http://localhost`.

## Provare dallo smartphone (stessa rete Wi-Fi)

1. Sul PC trova l'IP locale con `ipconfig` (voce "IPv4", es. `192.168.1.50`).
2. Dal telefono apri `http://192.168.1.50:5173`.

## Quando modifichi i file

- CSS / HTML / JS: salva e ricarica la pagina.
- Se non vedi il cambiamento è la cache del service worker:
  - ricarica con `Ctrl+F5`, oppure
  - DevTools (F12) -> Application -> Service Workers -> spunta "Update on reload".
- Durante lo sviluppo è comodo: DevTools -> Application -> Service Workers ->
  "Bypass for network" (serve sempre i file freschi, salta la cache).
- Dopo una modifica al codice va aggiornato `CACHE_NAME` in `sw.js`: al secondo
  reload la versione nuova si attiva da sola.

## Login / sync Supabase in locale (una volta sola)

Supabase -> Authentication -> URL Configuration: aggiungi `http://localhost:5173`
a Site URL e Redirect URLs. Serve solo per far accettare conferma email e reset
password durante i test. L'app funziona comunque offline anche senza login.

## Note

- `npx serve` / `http-server` restano in esecuzione e bloccano il terminale:
  lasciali girare in una finestra e usane un'altra per il resto. Si fermano con `Ctrl+C`.
