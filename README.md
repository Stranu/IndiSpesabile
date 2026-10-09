# Spesa

PWA locale-first per la spesa di casa: vanilla JavaScript, moduli ES nativi, nessun framework, nessun bundler, nessun passo di build. I dati vivono in IndexedDB (sorgente di verità) e vengono sincronizzati con Supabase quando sei collegato. L'interfaccia è in italiano e funziona offline una volta installata.

## 1. Avvio / servire l'app

Non c'è nessun passo di build: i file vanno serviti così come sono via HTTP(S). Qualsiasi file server statico va bene. Esempi dalla cartella del progetto:

```bash
# Python 3
python -m http.server 8000

# Node (senza installare nulla di permanente)
npx serve .
```

Poi apri `http://localhost:8000` (o la porta scelta).

L'app deve girare sia da **GitHub Pages** sia da `http://localhost`. Tutti i percorsi dei moduli e degli asset sono **relativi** (`./js/app.js`, `./styles.css`, `./sw.js`, …), quindi funziona sotto un sotto-percorso di Pages (es. `https://utente.github.io/repo/`) senza modifiche. Il service worker e la cache usano percorsi relativi per lo stesso motivo.

> Nota: il service worker richiede un contesto sicuro. `https://` (GitHub Pages) e `http://localhost` sono considerati sicuri dai browser; un IP LAN in `http://` semplice no, quindi lì il SW non si registra ma l'app resta usabile.

## 2. Setup Supabase (eseguire lo schema SQL)

Lo schema del database è in `supabase_schema.sql` (nella radice del progetto). Per applicarlo:

1. Apri il progetto su **Supabase**.
2. Vai in **SQL Editor** → **New query**.
3. Incolla l'intero contenuto di `supabase_schema.sql`.
4. Premi **Run**.

Lo script crea le quattro tabelle `spesa_*`, i relativi indici, abilita la Row Level Security (RLS) e definisce le policy di accesso per utente.

> **Importante — questo passo è manuale.** L'agente che implementa l'app **non può** eseguire SQL sul tuo progetto Supabase. Devi eseguire tu questo passaggio a mano dalla dashboard, altrimenti l'app non avrà le tabelle su cui sincronizzare.

## 3. Verifica della RLS (e stop se è disabilitata)

Dopo aver eseguito lo script, verifica che la sicurezza sia attiva. La sicurezza di questa app dipende **interamente** dalla RLS: la chiave anon è pubblica per design e da sola non protegge nulla.

1. Vai in **Database → Policies**.
2. Per **ciascuna** tabella `spesa_products`, `spesa_list`, `spesa_pantry`, `spesa_wishlist` controlla che:
   - lo stato della RLS sia **"Enabled"**;
   - siano presenti **esattamente 4 policy** (select / insert / update / delete, limitate a `user_id = auth.uid()`).

> **Fermati se una qualsiasi tabella `spesa_*` ha la RLS disabilitata o un numero di policy diverso da 4.** Con la RLS disabilitata i dati sarebbero leggibili/scrivibili da chiunque abbia la chiave anon pubblica. Non usare l'app finché tutte e quattro le tabelle non mostrano RLS "Enabled" con 4 policy ciascuna. In quel caso ri-esegui lo script (vedi la sezione "Ri-esecuzione dello script" più sotto) e ricontrolla.

## 4. Account condivisi e tabelle off-limits

Gli account (email + password) sono **condivisi** con l'altra app presente sullo stesso progetto Supabase: lo stesso login vale per entrambe.

Lo stesso progetto Supabase contiene **già** tabelle di quell'altra app:

- `workouts`
- `exercises`
- `weight_log`

Queste tabelle sono **off-limits**: questa PWA non le legge, non le scrive e non le modifica mai. L'app usa **solo** le proprie tabelle con prefisso `spesa_`. Non toccare le tabelle dell'altra app né dallo schema né da query manuali legate a questa app.

## 5. Configurazione URL in Authentication

Nella dashboard Supabase vai in **Authentication → URL Configuration** e aggiungi l'URL da cui servi l'app (es. l'URL di GitHub Pages e/o `http://localhost:8000`) sia a **Site URL** sia a **Redirect URLs**.

> Se l'URL di deploy non è registrato qui, Supabase **rifiuta** la conferma email e i redirect di autenticazione: la registrazione e il login via email non funzioneranno. Aggiungi ogni origine da cui l'app verrà aperta (Pages e localhost per lo sviluppo).

## 6. Ri-esecuzione dello script (errore "policy ... already exists")

Lo script è pensato per essere eseguito **una sola volta su un progetto nuovo**.

- I `create table` e i `create index` usano `if not exists`, quindi sono **idempotenti**: rieseguirli non causa errori.
- I `create policy` **non** supportano `IF NOT EXISTS` in Postgres. Perciò, se ri-esegui l'intero script su un progetto dove le policy esistono già, Postgres si ferma al primo `create policy` con un errore del tipo:

  ```
  ERROR: policy "..." for table "spesa_..." already exists
  ```

Questo errore è **atteso e innocuo** su una ri-esecuzione: significa che le tabelle e le policy sono già presenti e configurate. Puoi ignorarlo.

Se vuoi una ri-esecuzione pulita, elimina prima le policy `spesa_*` esistenti (es. `drop policy "..." on public.spesa_...;` per ciascuna) e poi rilancia lo script.

> **Lo `supabase_schema.sql` resta VERBATIM.** Non va modificato: non aggiungere `IF NOT EXISTS`, né `drop policy`, né altri guard al file. Questo comportamento è documentato qui nel README e **solo** qui — il file SQL rimane esattamente la copia verbatim dello schema concordato.

## 7. Generatore di icone

Le due icone della PWA, `icons/icon-192.png` e `icons/icon-512.png`, sono **generate** dallo script:

```bash
node tools/generate-icons.mjs
```

Lo script:

- usa **solo** moduli built-in di Node (es. `zlib` e `Buffer`), nessuna dipendenza npm;
- rigenera entrambe le PNG in `icons/`;
- **non** fa parte del runtime dell'app: `tools/` non viene mai servito né importato dall'app. Le PNG prodotte vanno committate (sono gli unici artefatti generati).

Esegui questo comando solo se devi rigenerare le icone; non serve per il normale utilizzo o deploy.

## 8. Manutenzione della precache del service worker

Il service worker (`sw.js`) ha un array `PRECACHE` che elenca **per nome** la shell dell'app (HTML/CSS/manifest/icone + ogni modulo `js/**` del grafo delle dipendenze della §2 del design). Questa lista deve restare allineata con la §2.

Quando aggiungi, rinomini o rimuovi un qualsiasi modulo `js/**` devi, insieme:

1. aggiornare il **grafo delle importazioni** (design §2);
2. aggiornare l'array **`PRECACHE`** in `sw.js`;
3. **incrementare la versione della cache** `spesa-cache-v1` (→ `spesa-cache-v2`, ecc.).

> Se salti anche solo uno di questi passi, la navigazione offline verso la sezione omessa o rinominata si rompe **silenziosamente**: la vecchia cache resta attiva e il nuovo modulo non viene mai precaricato. Il bump di `spesa-cache-v1` è ciò che permette alla fase `activate` di eliminare la cache obsoleta e far scaricare ai client la nuova shell.
