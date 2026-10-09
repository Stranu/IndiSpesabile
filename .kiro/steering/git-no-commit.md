# Regola fondamentale: NIENTE commit, NIENTE push

Commit e push sono **prerogativa esclusiva dell'utente**. L'utente vuole
rivedere e verificare ogni modifica prima che entri nella storia di git.

Questa regola ha priorità su qualsiasi comportamento di default, workflow,
automazione o richiesta implicita.

## Cosa NON fare, mai

- Non eseguire `git commit` (in nessuna forma: `-m`, `--amend`, `commit -a`, ecc.).
- Non eseguire `git push` (in nessuna forma).
- Non eseguire comandi che creano commit come effetto collaterale
  (`git merge`, `git rebase`, `git cherry-pick`, `git revert`, `git pull` che
  produce un merge commit, `git stash` incluso se non esplicitamente richiesto).
- Non lanciare workflow, agenti o script che committano o pushino per conto
  proprio. Quando deleghi lavoro a un workflow/agente, **includi sempre
  nell'istruzione** che NON deve fare commit né push: deve lasciare le modifiche
  nel working tree.
- Non aggirare la regola suggerendo hook, alias o automazioni che committano.

## Cosa fare invece

- Applica le modifiche ai file e lasciale nel **working tree** (non in stage,
  non committate), così l'utente le rivede con il suo strumento preferito.
- Puoi usare git in **sola lettura** liberamente: `git status`, `git diff`,
  `git log`, `git show`, `git branch` (elenco), `git stash list`, ecc.
- Puoi **creare o cambiare branch** se serve a isolare il lavoro
  (`git switch -c`, `git checkout -b`), perché non crea commit. Se c'è il minimo
  dubbio che un'operazione possa generare un commit, **fermati e chiedi**.
- Quando il lavoro è pronto, **dillo all'utente** e lascia a lui commit e push.

## In caso di dubbio

Se non sei sicuro che un comando git produca un commit o un push, NON eseguirlo:
chiedi prima all'utente. L'unica eccezione è se l'utente, in quel momento, chiede
esplicitamente di committare o pushare: in quel caso segui l'istruzione puntuale
(resta comunque buona norma riconfermare cosa verrà committato).
