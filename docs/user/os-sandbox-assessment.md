# Valutazione dell'isolamento OS

Status: current
Owner: docs/user/

Base di revisione: `75c7f629fdc221f242fc448389b4a010dc58a1da`, con #191 integrata. #190 è ancora aperta. Dopo il merge, integrare nuovamente `origin/main` e verificare che la sanitizzazione dell’ambiente dei figli e il blocco delle invocazioni operative di `serve` siano ancora attivi.

| Ramo upstream | SHA verificato | Decisione tecnica |
| --- | --- | --- |
| [ATO-469 / ATO-472](https://github.com/AtomicBot-ai/atomic-agent/pull/1612) | `93c6763d3cb3dae1fc6664e204fe098280337aed`, `94768b68f0c30cb81ffaa59eb679f9a3aa712c68`, `3296004ef0dbb36da4f960ad5da2f57b45c3eb78` | Importare con `cherry-pick -x` e adattare ai punti di avvio del fork. |
| [ATO-620](https://github.com/AtomicBot-ai/atomic-agent/pull/1630) | `4bee18579184f2a0a7bfe5e08d372c03eb6d2172` | Rinviare. La PR è chiusa senza merge. Il delta cambia schema, avvio MCP, accessi ai plugin e socket Docker e abilita la rete durante tutto il ciclo di vita del server. |

| Piattaforma | Meccanismo upstream | Prerequisiti e comportamento |
| --- | --- | --- |
| Linux | Bubblewrap rimonta la radice in sola lettura, rimonta le radici scrivibili e copre file e directory sensibili. `--unshare-net` isola le interfacce IP. `--proc /proc` senza namespace PID lascia visibili i processi del namespace corrente. | Serve un `bwrap` fidato e utilizzabile, con namespace e montaggi consentiti dall’host. Qui il binario esiste ma il probe fallisce sul mapping UID. Aggiungere namespace PID e procfs privato. I socket locali richiedono protezioni proprie. |
| macOS | `/usr/bin/sandbox-exec` applica un profilo Seatbelt parametrizzato. Upstream blocca uscite IP e socket locali con eccezione per loopback e blocca specifici servizi Mach per DNS e apertura URL. | Serve il binario e un profilo accettato dal sistema. Il binario è deprecato. Non c’è un namespace PID o una garanzia equivalente sulla visibilità di ambiente e argv di tutti gli altri processi. Verificare il profilo su macOS reale. |
| Windows | Nessun backend nel ramo. | Con richiesta esplicita di isolamento, rifiuto con errore leggibile. |

A sandbox esplicitamente attiva, strumento assente, inizializzazione fallita o profilo rifiutato devono produrre un errore senza rieseguire il comando fuori sandbox. La disattivazione esplicita torna al comportamento di main. Una prova di capacità deve distinguere un binario presente da un backend operativo.

| Confine | Garanzia applicativa | Garanzia OS da introdurre e limiti |
| --- | --- | --- |
| Approvazioni e livelli | Il dispatch conserva categorie, regole, grant e classificazione della shell. Al livello 4 un comando shell può partire senza domanda secondo la policy. | Il processo autorizzato resta confinato anche al livello 4. Il consenso al comando e quello alla rete sono decisioni distinte. |
| Scope di lettura | Percorsi riconosciuti verificati rispetto alla directory di lavoro, ai percorsi nominati e ai grant. I worker hanno un rifiuto più stretto. La classificazione dei percorsi shell ha visibilità limitata sugli script. | Mascherare stato e credenziali note anche per i discendenti. I file ordinari fuori radice restano leggibili secondo la politica OS adottata. Non presentare il read scope come allowlist kernel. |
| `serve-api.key`, `llama-server.key`, credenziali, ambiente e argv | Conservare protezione dei file al dispatch e filtri dei figli. #190 aggiunge protezioni per la chiave di serve e per `ATOMIC_AGENT_TOOL_CHILD`. Filtrare l’ambiente ereditato e isolare gli altri processi risolvono due problemi distinti. | Lo stato resta nascosto anche quando si sovrappone al progetto. Un’eventuale eccezione va limitata al percorso necessario e non può riaprire file di chiavi. Il namespace PID privato su Linux nasconde ambiente e argv dei processi host. Su macOS questa garanzia resta assente. |
| Cartelle di progetto e `folder_restricted` | La policy del progetto e lo scope del worker si valutano al dispatch. Un `cwd` del modello non conferisce permessi. | Scritture solo nelle radici fidate del progetto e in temporanei controllati. Spostare in un temporaneo le cache che richiedono scrittura. Verificare alias canonici, cartelle di stato annidate e checkout Git con metadati esterni. |
| Rete, egress e #191 | #191 applica l’egress del progetto prima dei consensi URL negli adattatori coperti. URL dinamici e redirect interni dei binari shell o server MCP sfuggono a quel punto di controllo. I controlli research di #166 richiedono egress HTTP e consenso una tantum sul trasporto applicativo. | Rete dei comandi spenta, con eccezione per comando soltanto dopo consenso esplicito e se l’egress del progetto lo consente. Una rete OS riaperta concede connettività generica. I limiti per dominio richiedono un trasporto mediato. Il fetch degli adattatori resta soggetto alle loro policy. |
| Shell e command-job | Preservare modalità diretta e interprete, output, timeout, cancellazione e detach. | Applicare il wrapper alla creazione del processo. Un job conservato o staccato mantiene il proprio confinamento. |
| `verify.run` | Le verifiche di comando e servizio hanno punti di avvio propri. Le verifiche research operano tramite trasporto applicativo. | Usare lo stesso wrapper per i processi di comando e servizio. La sonda HTTP controllata dal padre va valutata rispetto al namespace del servizio. Segnalare incompatibilità senza avviare il servizio senza protezione. |
| Worker Fusion | Restano validi limiti di lettura, scrittura, egress e approvazione del worker. | Usare la policy del worker anche per i suoi comandi e verifiche. Usare i punti di avvio condivisi e passare l’opzione al worker solo se necessario. |
| MCP stdio | Policy del dispatch sulle chiamate MCP e politica per URL espliciti. Un server persistente può lavorare già all’avvio. | Per un futuro import servono regole di rete valide anche prima della prima chiamata, radici fidate, accesso minimo al singolo plugin, esclusione esplicita per server, trattamento dei socket e fixture Linux/macOS. |

## Default deciso

La sandbox è facoltativa e spenta di default. Quando l’operatore la attiva, la mancanza del backend, un errore di inizializzazione o il rifiuto del profilo bloccano il comando. Il lancio senza isolamento richiede di disattivare esplicitamente la modalità.

L’attivazione automatica quando il backend è disponibile è rinviata fino a prove reali su Linux e macOS, comprese le verifiche di compatibilità dei flussi quotidiani.

## Verifiche di accettazione

Fixture con chiavi di serve e llama sintetiche, processo serve sintetico, tentativi di lettura protetta, scrittura fuori progetto e connessione verso una destinazione controllata. Controlli positivi per `npm test` nella fixture e `git status`. Verificare parità con isolamento spento e rifiuto esplicito quando il backend manca o fallisce il probe. I test di isolamento reale richiedono il backend operativo e devono indicare il motivo di uno skip. Confrontare per nome i fallimenti della suite intera con main.
